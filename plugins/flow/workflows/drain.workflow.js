export const meta = {
  name: 'flow-drain',
  description:
    'Stage-1 stateless drain: a per-story loop (claim -> dev -> review -> verdict -> auto-merge gate) driven entirely through one-shot CLI seams — NO persistent MCP server on the drain path, so the cascade-SIGTERM disconnect cannot occur by construction. The main loop dispatches up to maxConcurrency stories at once (Story 8.22); per-dev worktree isolation (8.20) makes that safe. Recovers crash-orphaned stories first (auto-resume, serial). Story 8.5 + crash-recovery + concurrency.',
  phases: [
    { title: 'recover', detail: 'scan in-progress/ for crash-orphaned stories from a prior run; auto-resume each (resume at review if a PR exists, else re-run), serial, capped' },
    { title: 'drain', detail: 'bounded-concurrent per story (up to maxConcurrency at once): claim -> dev (worktree) -> processDevTranscript -> review -> processReviewerTranscript -> (rework) -> auto-merge gate' },
  ],
}

// ---------------------------------------------------------------------------
// Args. The Workflow runtime delivers `args` as a JSON STRING — parse defensively.
//   targetRepoRoot : absolute path to the target repo (the repo being built)
//   cli            : absolute path to the plugin's `mcp-server/dist/cli.js`
//                    (the stateless seam transport; lives in the PLUGIN, not the target)
//   sessionUlid    : (optional) launcher-minted id — pass it for journal-stable resume;
//                    omitted → minted in-script for a standalone run
//   maxStories     : OPTIONAL safety cap on stories claimed this run. Omitted →
//                    drain until the queue is empty (the headline). Provided → stop after N.
//   maxRework      : per-story NEEDS-CHANGES rework cap. Default 2.
//   maxResume      : per-story crash-resume cap. Past this many auto-resumes a
//                    still-orphaned story is blocked for a human. Default 2.
//   maxConcurrency     : OPTIONAL cap on how many stories the MAIN drain loop runs at
//                    once (Story 8.22). Default 2. 1 → the historical strictly-serial
//                    loop. Non-positive/garbage → the default. The orphan-resume
//                    prelude stays serial regardless. Per-dev worktree isolation
//                    (Story 8.20) is what makes >1 safe; the atomic claim guarantees
//                    no two workers ever pick up the same ref.
//   devReviewerModel : OPTIONAL model string for the dev and reviewer subagents.
//                    Default 'sonnet'. Override to 'opus' (or any model) for a higher-
//                    quality (higher-cost) run. Does NOT affect the seam-relay courier
//                    (always 'sonnet'), the judge panel, or persona/QL calls.
// ---------------------------------------------------------------------------
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const REPO = A.targetRepoRoot || A.repo
const CLI = A.cli
// Optional safety cap. Omitted (or non-positive/garbage) → unbounded drain: the
// queue strictly shrinks (claimNextStory atomically moves to-do→in-progress), so
// the loop always terminates on queue-drained. A positive integer caps the run.
const MAX = Number.isInteger(A.maxStories) && A.maxStories > 0 ? A.maxStories : Infinity
const MAX_REWORK = A.maxRework || 2
const MAX_RESUME = Number.isInteger(A.maxResume) && A.maxResume > 0 ? A.maxResume : 2
// Concurrency cap for the main drain loop (Story 8.22). Mirrors the maxStories /
// maxRework / maxResume knobs. Default 2; clamp a non-positive/garbage value to 1
// so the loop is never spawned with zero workers (which would never drain).
const MAX_CONCURRENCY = Number.isInteger(A.maxConcurrency) && A.maxConcurrency > 0 ? A.maxConcurrency : 2
// Execution model for the dev and reviewer subagents (FU6). Default: 'sonnet' so
// overnight drains use the cheaper model without hand-editing the workflow.
// Override per-run by passing devReviewerModel: 'opus' (or any model string) in
// the launch args. Does NOT affect the seam-relay courier (already 'sonnet'), the
// judge panel, or persona/QL calls.
const execModel = (A && A.devReviewerModel) || 'sonnet'

const HANDOFF = (ref) => `Handoff to reviewer — story ${ref} ready for review.`

// NEEDS-HUMAN-DECISION signal (Story 8.19): the dev emits this locked marker as
// its last line — INSTEAD of the handoff phrase — when it hits a genuine
// decision a human must make to proceed correctly (distinct from a normal
// handoff, a domain-yield, and a hard block). The drain detects the marker on
// the REAL dev transcript, asks processDevTranscript to extract the verbatim
// question (the tool owns the parse), routes the story to the human-needed
// surface (pausedForHuman) carrying the question, NOTIFIES the operator, and
// continues to the next claimable story rather than halting the whole run.
const NEEDS_HUMAN_MARKER = /^needs-human-decision:[ \t]*\S/m

// Clamp a seam-agent's output to a single stdout string: the courier cannot
// "decide" — the tool already decided, and the script switches on the parse.
const RawSchema = { type: 'object', additionalProperties: false, properties: { stdout: { type: 'string' } }, required: ['stdout'] }
const safeParse = (s) => { try { return JSON.parse(String(s).trim()) } catch (e) { return { _parseError: String(e), raw: String(s).slice(0, 400) } } }
const J = (o) => JSON.stringify(o)

// A SEAM: a cheap one-shot courier (sonnet) that runs ONE CLI command verbatim
// and returns its single JSON line. This is the deterministic-seam discipline —
// every load-bearing decision is a tool call, never script JS and never agent prose.
// `retryable` re-invokes the courier on a garbled (non-JSON) relay — a fresh LLM
// call usually returns clean JSON. Safe ONLY for read-only / idempotent seams.
// MUTATING seams (claim / verdict / gate) leave retryable=false: a garble there
// safely pauses that one story (no-silent-failure) rather than risk re-applying a
// mutation the first call may already have landed. Sonnet makes garbles rare to begin with.
//
// `swallow` (Story 8.21) extends the existing "no line, keep going" degrade
// convention from a *garbled* relay to a *hard rejection* of the underlying
// courier call (the agent() promise throws/rejects, rather than merely returning
// a non-JSON line). It is opt-in and scoped EXPLICITLY to pure-observability /
// read-only seams — only the progress heartbeat passes it. With swallow=true a
// thrown courier call is converted into the same `_parseError` sentinel a garble
// produces, so the caller degrades identically (the wrappers skip the line and
// the story proceeds). The MUTATING seams (claim / verdict / gate) never pass
// swallow, so a hard rejection there still propagates and fails loud — preserving
// the no-silent-failure contract (that one story pauses or blocks, never a fake
// success). The guard lives HERE, gated on this flag, rather than around
// processStory: wrapping processStory would also swallow load-bearing failures
// and reintroduce silent-success, which is exactly what this story forbids.
const seam = async (cmd, label, retryable = false, swallow = false) => {
  const attempts = retryable ? 3 : 1
  let parsed = { _parseError: 'agent-null' }
  for (let a = 0; a < attempts; a++) {
    let r
    try {
      r = await agent(
        `You are a deterministic command runner. Use the Bash tool to execute the command below EXACTLY as written. ` +
          `Hard rules: do NOT modify the command, do NOT change or "correct" any path, do NOT cd, do NOT read files, do NOT run anything else. ` +
          `It prints exactly one line of JSON to stdout — return that line verbatim in the "stdout" field.\n\nCOMMAND:\n${cmd}`,
        { schema: RawSchema, label, phase: 'drain', model: 'sonnet' },
      )
    } catch (e) {
      // HARD rejection of the courier call. For an observability seam we degrade
      // exactly as for a garble (no line, keep going); for any other (mutating)
      // seam we re-throw so the failure stays loud and reaches its bucket.
      if (!swallow) throw e
      parsed = { _parseError: `seam-threw: ${String(e)}` }
      log(`seam ${label} hard-failed (observability, swallowed) — no progress line, continuing`)
      return parsed
    }
    parsed = r ? safeParse(r.stdout) : { _parseError: 'agent-null' }
    if (!parsed._parseError) return parsed
    if (a < attempts - 1) log(`seam ${label} garbled relay (attempt ${a + 1}/${attempts}) — retrying`)
  }
  return parsed
}

// PROGRESS HEARTBEAT (Story 8.18): bracket each long per-story phase with an
// operator-facing start line and a done line that carries elapsed wall-clock
// time, so a long silent span (notably the ~10-minute dev-build) is no longer
// indistinguishable from a hang. These lines are emitted through the SAME
// narrator (`log()`) and change NO control flow — purely additive observability.
//
// The wall clock is read through the CLI seam (drainPhaseStart/drainPhaseDone),
// never in-script: the Workflow runtime forbids the script from calling
// Date.now()/new Date() (resume-determinism), but a seam result is recorded and
// replayed, so reading the clock through a seam stays deterministic. The pure,
// unit-tested formatDrainProgress helper does the formatting inside those tools.
//
// progressStart(ref, ph) -> the epoch-ms start time (handed back to progressDone)
// progressDone(ref, ph, startedAtMs) -> emits the elapsed line.
// Both are read-only/idempotent → retryable, AND swallow (Story 8.21): a garbled
// relay OR a hard rejection of the underlying courier never breaks the run —
// progressStart falls back to a null start time and progressDone then renders
// 0ms. The heartbeat is pure observability, so it degrades to no line on ANY
// failure (garble or throw) rather than ever failing the story or the drain.
const progressStart = async (ref, ph) => {
  const r = await seam(`node ${CLI} drainPhaseStart --json '${J({ ref, phase: ph })}'`, `progress-start:${ref}:${ph}`, true, true)
  if (r && !r._parseError && typeof r.line === 'string') log(r.line)
  return r && typeof r.atMs === 'number' ? r.atMs : null
}
const progressDone = async (ref, ph, startedAtMs) => {
  const r = await seam(`node ${CLI} drainPhaseDone --json '${J({ ref, phase: ph, startedAtMs: startedAtMs ?? 0 })}'`, `progress-done:${ref}:${ph}`, true, true)
  if (r && !r._parseError && typeof r.line === 'string') log(r.line)
}

// OPERATOR NOTIFICATION (Story 8.19): when a story pauses for a human decision,
// the drain pushes a notification naming the ref and the question. The binding
// contract is "the question reaches the operator with the ref" — we do NOT
// hard-wire a specific notifier the runtime may not expose. The drain narrator
// (`log()`) is the channel the runtime always provides, so we surface the pause
// there; if the runtime additionally injects a dedicated `notify` seam (e.g. a
// push channel), we route through that too. This path is exercised by the drain
// integration test via an injected notifier so a future change cannot silently
// drop it. `typeof` guards keep the workflow safe when no `notify` is injected.
const notifyHumanNeeded = (ref, question) => {
  const line = `NEEDS HUMAN — story ${ref} paused for a decision. question: ${question}`
  log(line)
  if (typeof notify === 'function') {
    try { notify({ kind: 'needs-human-decision', ref, question, line }) } catch (_e) { /* notification is best-effort; never break the drain */ }
  }
}

// CLEAN-ROOT GUARD (Epic 10 drain fix-plan, Fix 2b): the dev edits inside its OWN
// per-story worktree (Story 8.20), so the orchestrating root checkout should stay
// clean. But in a BACKGROUND job the repo's `worktree.bgIsolation: "none"` setting
// can suppress that isolation, pinning the dev's edits to the shared root instead
// (Epic 10 drain retro, Issue B — observed mid-10.2, recurred 0/5 across the
// batch). After each story settles we ask the guard tool whether the root carries
// any leaked tracked changes (operational `.flow/**` is gitignored, so only a real
// source leak shows); if so it stashes exactly those paths non-destructively
// (recoverable via `git stash`) so the NEXT story's worktree is still cut from a
// clean base, and we log a LOUD warning here. This converts a silent leak into a
// visible, safe one — it does not pretend to make concurrent drains under a broken
// isolation flag correct. Read-mostly + idempotent (a second call after a stash
// finds the root clean), so retryable; a garbled relay never breaks the run.
const guardRoot = async (ref) => {
  const g = await seam(`node ${CLI} guardCleanRoot --json '${J({ targetRepoRoot: REPO, ref })}'`, `clean-root-guard:${ref}`, true)
  if (g && !g._parseError && g.dirty) {
    const paths = Array.isArray(g.paths) ? g.paths : []
    const shown = paths.slice(0, 8).join(', ')
    const more = paths.length > 8 ? `, +${paths.length - 8} more` : ''
    log(`⚠ CLEAN-ROOT GUARD: root checkout was dirty after ${ref} — ${paths.length} leaked path(s): ${shown}${more}. ` +
      `${g.stashed ? 'Auto-stashed (recover via `git stash list` / `git stash pop`).' : 'STASH DID NOT LAND — root still dirty; inspect manually.'} ` +
      `Likely a worktree-isolation leak (bgIsolation:'none').`)
  }
}

phase('drain')
if (!REPO || !CLI) return { error: 'missing-args', need: ['targetRepoRoot', 'cli'], got: Object.keys(A) }

// Session id: prefer the launcher-minted id (Layer-1 journal stability across
// resume); fall back to minting one via the CLI for a standalone run.
const SU = A.sessionUlid || (await seam(`node ${CLI} mintSessionUlid`, 'mint', true)).sessionUlid
if (!SU) return { error: 'no-session-ulid' }
log(`drain session=${SU} repo=${REPO} maxStories=${MAX === Infinity ? 'unbounded' : MAX} maxRework=${MAX_REWORK} maxResume=${MAX_RESUME} maxConcurrency=${MAX_CONCURRENCY}`)

// Persona system prompts — these carry the evidence-only discipline (Story 8.3):
// agents produce code / a PR / a transcript; the TOOLS own the backlog ledger.
// The reviewer persona is fetched up-front too so a crash-resume that skips dev
// can still drive the review (it is exactly the prompt processDevTranscript
// would otherwise hand back — just the persona system prompt, no story context).
const devPersona = (await seam(`node ${CLI} buildPersonaSpawnPrompt --json '${J({ targetRepoRoot: REPO, role: 'generalist-dev' })}'`, 'persona:dev', true))?.systemPrompt || ''
const reviewerPersona = (await seam(`node ${CLI} buildPersonaSpawnPrompt --json '${J({ targetRepoRoot: REPO, role: 'generalist-reviewer' })}'`, 'persona:reviewer', true))?.systemPrompt || ''

const completed = [], merged = [], pausedForHuman = [], blocked = [], resumed = []
// Set the moment the loop exits; every break path below overwrites this placeholder.
let drainedReason = 'incomplete'

// processStory: run ONE story end-to-end — rework loop (dev → review → verdict)
// then the auto-merge gate — and file the outcome into exactly one result bucket.
// Used by BOTH the orphan-resume prelude and the main claim loop.
//   resumeAtReview=true  → the PR already exists from a crashed run; SKIP the dev
//     spawn on the first iteration and review the existing PR (resumePrNumber).
//     Any NEEDS-CHANGES rework after that runs dev normally (it pushes to the
//     same existing PR, exactly as a normal rework round does).
async function processStory({ ref, title, manifestPath, resumeAtReview = false, resumePrNumber = null, ph = 'drain', tag = '' }) {
  let verdict = null, prNumber = resumeAtReview ? resumePrNumber : null

  for (let rw = 0; rw < MAX_REWORK; rw++) {
    const skipDev = resumeAtReview && rw === 0
    let reviewerPrompt

    if (skipDev) {
      // CRASH-RESUME at review: the dev already shipped a PR in the prior run.
      // Re-running dev would try to re-open a duplicate PR, so we skip it and
      // review the existing PR directly. reviewerPrompt is just the persona
      // (what processDevTranscript would otherwise return).
      reviewerPrompt = reviewerPersona
      log(`${ref} resume-at-review -> PR #${prNumber} (dev already shipped; skipping dev)`)
    } else {
      // DEV — persona prompt (judgment + evidence-only discipline). The dev edits
      // and builds INSIDE ITS OWN WORKTREE (Story 8.20): the `isolation: 'worktree'`
      // per-agent primitive roots the subagent's working directory in a fresh
      // worktree cut clean from the base, so the dev's *editing surface* — not just
      // its commit — is per-worktree. Two devs against the same repo therefore can
      // never cross-contaminate edits, which is what makes the deferred concurrent
      // dispatch (bmad:8.22) safe by construction. The orchestrating checkout is
      // never the dev's editing surface. Because the worktree contains ONLY the
      // dev's own work, runDevTerminalAction stages the worktree's own dirty set
      // (an explicit changed-paths stage — never `git add .`); the 8.16
      // snapshot-baseline/transplant is gone (it was the serial-only workaround).
      // The dev passes its OWN working directory as targetRepoRoot (the worktree),
      // NOT the orchestrating REPO — the tool maps the worktree back to the
      // orchestrating checkout for the session ledger via `git --git-common-dir`.
      // The PR number transports via dev-outcome.json (machine-authoritative), not chat.
      // HEARTBEAT: enter the dev-build phase — the longest per-story span (the
      // single long dev agent() call). The start line flags it as the long one
      // so an operator reading the narrator knows a multi-minute gap is expected.
      const devStartedAt = await progressStart(ref, 'dev-build')
      const reworkNote = rw === 0 ? '' :
        `\n\nThis is rework iteration ${rw}: address the reviewer's NEEDS CHANGES feedback on the existing PR (read .flow/state for the recorded verdict), push the fixes, and hand off again.`
      const devFinal = await agent(
        `${devPersona}\n\n## This run (story ${ref})\n` +
          `- ref: ${ref}\n- title: "${title}"\n- sessionUlid: ${SU}\n- manifestPath: ${manifestPath}\n\n` +
          `You are working inside your OWN dedicated git worktree (your current working directory) — a clean checkout cut for this story alone. Edit and build HERE; never reach outside it.\n` +
          `Read the execution manifest at \`${manifestPath}\` — it identifies the source story and its acceptance criteria. ` +
          `Implement the story end-to-end in your working directory: write real code and tests, and run the project's build/test gates GREEN before opening the PR. ` +
          `Do NOT gold-plate; do NOT touch the execution manifest or any \`.flow/state\` file (the tools own the ledger).\n\n` +
          `To commit, push, and open the PR, run EXACTLY this — but FIRST replace \`<your-working-directory>\` with the absolute path of your current working directory (run \`pwd\` if unsure); do not alter any other field; fill \`body\` and \`summary\` with a real description of your change:\n` +
          `  node ${CLI} runDevTerminalAction --json '${J({ targetRepoRoot: '<your-working-directory>', ref, title, type: 'feat', manifestPath, sessionUlid: SU, body: '<one-paragraph body>', summary: '<one-line summary>' })}'\n` +
          `That tool runs the project's full build itself (the same whole-project build CI runs) before opening the PR and refuses to open one on a red build (Story 8.17), so a red PR can no longer leak — but still build green yourself first. ` +
          `Confirm it prints "ok":true and a "prUrl". If it prints a PrePrBuildFailedError, the build gate caught a red build — read the captured stderr/stdout in the error, fix the build (including breakage in files your story did not touch), and re-run the tool; do NOT hand off and do NOT emit the gh-recoverable line for a build failure. If it prints any other "error", or any flow tool raises GhRecoverableError, emit the verbatim \`gh-recoverable: ...\` line as your LAST line and stop — do NOT emit the handoff phrase.${reworkNote}\n\n` +
          `Otherwise, end your final message with EXACTLY this line and nothing after it:\n${HANDOFF(ref)}`,
        { label: `dev:${ref}:${rw}${tag}`, phase: ph, isolation: 'worktree', model: execModel },
      )

      const devText = String(devFinal || '')

      // NEEDS-HUMAN-DECISION (Story 8.19): the dev signalled a genuine decision a
      // human must make — checked BEFORE the handoff/`dev-no-handoff` paths so an
      // ambiguity pause is never mistaken for a dirty no-handoff exit or a silent
      // failure. processDevTranscript owns the parse (extracts the verbatim
      // question and stamps the manifest); the script only routes. We pass the
      // REAL dev transcript here (not the synthesised handoff phrase) so the tool
      // can read the question. On a clean parse we file the story into the
      // human-needed surface (pausedForHuman) carrying its question, NOTIFY the
      // operator, and RETURN — no PR is opened and the drain continues to the
      // next claimable story. retryable=true: the tool is idempotent (re-stamps
      // the same blocked_by, re-extracts the same question).
      if (NEEDS_HUMAN_MARKER.test(devText)) {
        const ph0 = await seam(`node ${CLI} processDevTranscript --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, ref, devTranscript: devText })}'`, `pd-needs-human:${ref}:${rw}${tag}`, true)
        if (ph0 && ph0.next === 'done-needs-human-decision') {
          const question = ph0.question || '(no question text captured)'
          pausedForHuman.push({ ref, reason: 'needs-human-decision', question })
          notifyHumanNeeded(ref, question)
          return
        }
        // Marker present but the tool did not confirm it (garbled relay / parse
        // miss): fall through to the normal evidence checks below rather than
        // guess — a no-handoff exit then blocks the story (no silent success).
      }

      // Evidence check (in-script, cheap): the dev must have genuinely handed off.
      // We do NOT fabricate a handoff — if the real transcript lacks the locked
      // phrase, the dev did not finish cleanly; block rather than fake success.
      if (!devText.includes(HANDOFF(ref))) {
        blocked.push({ ref, blocked_by: 'dev-no-handoff', tail: devText.slice(-300) })
        return
      }

      // PARSE DEV — locked-grammar handoff parse + prNumber from dev-outcome.json.
      // processDevTranscript is idempotent (re-reads dev-outcome.json, re-stamps the
      // same blocked_by) — safe to retry the relay on a garble.
      const pd = await seam(`node ${CLI} processDevTranscript --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, ref, devTranscript: HANDOFF(ref) })}'`, `pd:${ref}:${rw}${tag}`, true)
      if (!pd || pd.next !== 'spawn-reviewer') { blocked.push({ ref, blocked_by: pd?.next || pd?._parseError || 'pd-failed' }); return }
      prNumber = pd.prNumber
      reviewerPrompt = pd.reviewerPrompt
      log(`${ref} -> PR #${prNumber}`)
      // HEARTBEAT: leave the dev-build phase with elapsed wall-clock time.
      await progressDone(ref, 'dev-build', devStartedAt)
    }

    // REVIEW — clean context. The reviewer's binding verdict transports through
    // the reviewer-result FILE that runReviewerSession writes (never chat).
    // HEARTBEAT: bracket the review phase (start → done with elapsed time).
    const reviewStartedAt = await progressStart(ref, 'review')
    await agent(
      `${reviewerPrompt}\n\n## How to run the review in this stateless run\n` +
        `Your FIRST and only mandatory action is to run EXACTLY this command (do not alter the path); it performs the three mandatory reads and writes the binding verdict to reviewer-result.json:\n` +
        `  node ${CLI} runReviewerSession --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, ref, prNumber, role: 'generalist-reviewer' })}'\n` +
        `Then summarise the result it prints for the operator. Do NOT merge, push, edit the PR, or write any \`.flow/state\` file yourself — runReviewerSession owns the verdict file.`,
      { label: `rev:${ref}:${rw}${tag}`, phase: ph, model: execModel },
    )
    await progressDone(ref, 'review', reviewStartedAt)

    // VERDICT — derived from the reviewer-result FILE; on green, completeStory
    // runs inside processReviewerTranscript (atomic in-progress -> done).
    verdict = await seam(`node ${CLI} processReviewerTranscript --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, ref, manifestPath })}'`, `verdict:${ref}:${rw}${tag}`)
    const v = verdict?.next
    log(`${ref} verdict -> ${v}`)
    if (v === 'done-ready-for-merge') break
    if (v === 'done-blocked-reviewer-needs-changes') continue // rework
    blocked.push({ ref, blocked_by: v || verdict?._parseError || 'verdict-failed' }); return
  }

  // GATE — only on a green verdict. risk-tier x agreement x threshold; the tool
  // performs the merge or applies the needs-human label. Stage-1 expects
  // pause-needs-human (no agreement history yet) -> a human merges.
  if (verdict?.next === 'done-ready-for-merge') {
    completed.push(ref)
    // HEARTBEAT: bracket the gate phase (start → done with elapsed time).
    const gateStartedAt = await progressStart(ref, 'gate')
    const gate = await seam(`node ${CLI} runAutoMergeGate --json '${J({ targetRepoRoot: REPO, prNumber, ref, sessionUlid: SU })}'`, `gate:${ref}`)
    await progressDone(ref, 'gate', gateStartedAt)
    if (gate?.decision === 'auto-merge') merged.push({ ref, prNumber })
    else pausedForHuman.push({ ref, prNumber, reason: gate?.reason || gate?.decision || gate?._parseError || 'gate-failed' })
  }
}

// ── ORPHAN RECOVERY (crash resume) ─────────────────────────────────────────
// A prior run that died mid-story leaves the manifest in in-progress/ claimed by
// a now-stale session. Recover BEFORE draining new work: for each orphan, either
// resume at review (a PR already exists — skip dev) or re-run the story (no PR),
// capped by maxResume so a story that keeps crashing the loop is blocked for a
// human instead of looping forever. scanOrphanedInProgress is read-only/idempotent
// (retryable); reattach/block are one-shot mutations.
phase('recover')
// STALE-WORKTREE REAPING (Story 8.20 AC4): a worker that died mid-build leaves a
// dev-story worktree keyed by its now-dead session id. The per-path stale-reap in
// materialiseDevStoryWorktree only matches the LIVE session's own path, so
// cross-session leftovers would otherwise accumulate. Reap them here — keyed on
// the live session so this session's own in-flight worktrees are never touched —
// alongside the in-progress manifest scan. Read-only/idempotent → retryable; a
// garbled relay never breaks the run (worst case a leftover is reaped next time).
const reap = await seam(`node ${CLI} reapStaleWorktrees --json '${J({ targetRepoRoot: REPO, sessionUlid: SU })}'`, 'worktree-reap', true)
if (reap && Array.isArray(reap.reaped) && reap.reaped.length) log(`reaped ${reap.reaped.length} stale dev worktree(s) from dead session(s)`)
const scan = await seam(`node ${CLI} scanOrphanedInProgress --json '${J({ targetRepoRoot: REPO, sessionUlid: SU })}'`, 'orphan-scan', true)
const orphans = scan && Array.isArray(scan.orphans) ? scan.orphans : []
if (orphans.length) log(`orphan recovery: ${orphans.length} in-progress story(ies) left by a prior run`)
for (const o of orphans) {
  const { ref, title, prNumber, resumeAttempts, staleUlid, manifestPath } = o
  // CAP — past the resume limit, block for a human rather than re-resume forever.
  if ((resumeAttempts || 0) >= MAX_RESUME) {
    await seam(`node ${CLI} blockOrphanNoTranscript --json '${J({ targetRepoRoot: REPO, ref, staleUlid })}'`, `orphan-block:${ref}`)
    blocked.push({ ref, blocked_by: 'orphan-resume-cap', resumeAttempts })
    log(`orphan ${ref} hit resume cap (${resumeAttempts}/${MAX_RESUME}) -> blocked for a human`)
    continue
  }
  // Take ownership (reattachOrphan rewrites claimed_by → this session AND bumps
  // drain_resume_attempts, so the cap advances every resume).
  const re = await seam(`node ${CLI} reattachOrphan --json '${J({ targetRepoRoot: REPO, ref, currentSessionUlid: SU })}'`, `orphan-reattach:${ref}`)
  if (!re || re._parseError) { blocked.push({ ref, blocked_by: re?._parseError || 'reattach-failed' }); continue }
  const mode = prNumber ? 'resume-at-review' : 're-run'
  resumed.push({ ref, mode, attempt: re.resumeAttempts })
  log(`resuming orphan ${ref} (${mode}, attempt ${re.resumeAttempts})`)
  await processStory({ ref, title, manifestPath, resumeAtReview: !!prNumber, resumePrNumber: prNumber || null, ph: 'recover', tag: ':resume' })
  await guardRoot(ref)
}

// ── MAIN DRAIN (concurrent — Story 8.22) ────────────────────────────────────
// The loop is no longer strictly serial: up to MAX_CONCURRENCY workers each run
// the SAME claim→processStory cycle at once, so a backlog drains in parallel
// wall-clock time. Concurrency changes THROUGHPUT only, never correctness — the
// guarantees that hold are exactly the serial loop's:
//
//  • Each story is processed exactly once. claimNextStory is an atomic
//    to-do→in-progress rename (single-syscall) — one worker wins each ref, the
//    loser gets a clean miss — so two workers can never hand out the same story.
//  • At most MAX_CONCURRENCY stories are in flight. A worker only starts a new
//    story after its previous one settles; with W workers, at most W are live.
//  • The maxStories cap is honoured run-wide. `claimsStarted` is reserved with a
//    SYNCHRONOUS check-and-increment (no `await` between the read and the bump),
//    and the Workflow runtime is single-threaded cooperative async, so two
//    workers can never both reserve the final slot.
//  • Per-worker failure is isolated. Each worker body is wrapped so a throw lands
//    that one story in `blocked` (its reason preserved) and never aborts the run
//    or disturbs a concurrently-running sibling — exactly the per-item isolation
//    a substrate `parallel`/`pipeline` would give; hand-rolled here because the
//    drain script reaches its seams through injected globals, not a pool import.
//  • The drain reason is derived ONCE from the first terminal claim outcome
//    (queue-drained / cap / claim error), under a guard, not from whichever
//    worker finishes last — so the honest-exit surface (Story 8.14) is unchanged.
//
// Result buckets stay the in-place append-only `.push()`es processStory already
// does: append is atomic under the single-threaded runtime (no torn writes), so
// no worker's outcome can be lost or double-counted.
phase('drain')
let claimsStarted = 0 // claims reserved this run (caps the run at MAX claims)
let stop = false // set the moment any worker observes a terminal claim outcome
// Record the first terminal claim outcome as the drain reason; later workers'
// outcomes are ignored so the reason is derived once, not last-writer-wins.
let reasonRecorded = false
const recordReason = (r) => { if (!reasonRecorded) { reasonRecorded = true; drainedReason = r; stop = true } }

async function drainWorker(workerId) {
  for (;;) {
    // Reserve a claim slot SYNCHRONOUSLY (no await between the read and the bump)
    // so concurrent workers can never both take the final slot. A terminal flag
    // or the cap stops this worker; it then drains its already-claimed work and
    // returns — siblings still in flight keep going.
    if (stop) return
    if (claimsStarted >= MAX) { recordReason('max-stories-reached'); return }
    const claimIdx = claimsStarted++
    // CLAIM — atomic to-do -> in-progress; deps satisfied from done/ only.
    // 'queue-drained' is the happy unattended path; any other non-spawn-dev
    // outcome (waiting-on-in-progress, parse/claim error) is surfaced verbatim.
    const claim = await seam(`node ${CLI} claimNextStory --json '${J({ targetRepoRoot: REPO, sessionUlid: SU })}'`, `claim:${claimIdx}`)
    if (!claim || claim.next !== 'spawn-dev') { recordReason(claim?.next || claim?._parseError || 'claim-failed'); return }
    const { ref, title, manifestPath } = claim
    log(`claimed ${ref} — ${title} (worker ${workerId})`)
    // PER-WORKER ISOLATION: a throw inside processStory (a seam hard-rejection, a
    // build crash, any unexpected error) must land THIS story in blocked with its
    // reason and never abort the run or poison a sibling. processStory already
    // buckets every *expected* outcome itself; this catch is the backstop for an
    // UNEXPECTED throw so the no-silent-failures surface holds even then.
    try {
      await processStory({ ref, title, manifestPath })
    } catch (e) {
      // Preserve the failure REASON (the error message — what an operator needs)
      // up front, with a short stack tail for context. Capturing .message first
      // (not slicing the tail of .stack) keeps the reason from being truncated
      // away when the stack is long.
      const msg = String(e && e.message ? e.message : e)
      const stackTail = String((e && e.stack) || '').slice(-200)
      blocked.push({ ref, blocked_by: 'worker-threw', tail: msg, stackTail })
      log(`worker ${workerId} story ${ref} threw — bucketed blocked (${msg.slice(0, 120)}), run continues`)
    }
    // CLEAN-ROOT GUARD (Fix 2b): runs whether the story settled or threw, so a
    // leaked-then-crashed story still can't leave the root dirty for the next claim.
    await guardRoot(ref)
  }
}

// Spawn the bounded pool and wait for every worker to settle. allSettled (not
// all) is belt-and-braces: even a worker that somehow rejects past its own catch
// cannot reject the pool and abort the run.
const workerCount = Math.max(1, Math.min(MAX_CONCURRENCY, MAX === Infinity ? MAX_CONCURRENCY : MAX))
await Promise.allSettled(Array.from({ length: workerCount }, (_, w) => drainWorker(w)))

// The return object IS the no-silent-failures surface: every ref lands in exactly
// one of completed / merged / pausedForHuman / blocked, with a drain reason.
// `resumed` additionally records which stories were crash-recovered this run.
return {
  sessionUlid: SU,
  drainedReason,
  // True ONLY on a genuine full drain (queue emptied). Hitting the cap,
  // waiting-on-in-progress, or any claim error is NOT a drain.
  drained: drainedReason === 'queue-drained',
  resumed,
  completed,
  merged,
  pausedForHuman,
  blocked,
}
