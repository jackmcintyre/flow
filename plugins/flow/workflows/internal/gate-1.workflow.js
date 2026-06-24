// Engine-internal workflow — lives in workflows/internal/ so it is NOT
// auto-discovered as an operator-facing slash command.  Invoked by the
// run-system CLI seam; not directly user-callable.
export const meta = {
  name: 'flow-gate-1',
  // NB: this MUST be a single string literal (not a `+` concatenation). The
  // Workflow runtime requires `meta` to be a pure literal and rejects a
  // BinaryExpression here — a concatenated description makes the whole workflow
  // unlaunchable via the Workflow tool (the only path that runs gate-1).
  description: 'Gate-1 workflow: deterministically fans out all five lens judges in parallel (per-lens model tiering: Structure+Discipline on Sonnet, the rest on Opus) and returns a structured pass/fail verdict with Quality Lead adjudication. round=1 k=1: a clean sweep blesses ready, any lens fail escalates. Mirrors run.workflow.js seam() courier discipline (load-bearing decisions live in tool results, never agent prose). Story native:01KT1MP7TR651TAGVJ6EZSR589.',
  phases: [
    { title: 'mint', detail: 'mint a session ULID and fetch the team roster + persona' },
    { title: 'judge', detail: 'fan out five lens judges in parallel; each writes its verdict file via writeLensVerdict' },
    { title: 'aggregate', detail: 'call aggregateJudgePanel to read all five files + validate; then adjudicateQualityLead with round=1 k=1' },
  ],
}

// ---------------------------------------------------------------------------
// Args. The Workflow runtime delivers `args` as a JSON STRING — parse defensively.
//   targetRepoRoot : absolute path to the target repo
//   cli            : absolute path to mcp-server/dist/cli.js
//   ref            : the drafted story ref (e.g. native:01KT...)
//   sessionUlid    : (optional) launcher-minted ULID; minted via CLI if absent
// ---------------------------------------------------------------------------
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const REPO = A.targetRepoRoot || A.repo
const CLI = A.cli
const REF = A.ref

phase('mint')
if (!REPO || !CLI || !REF) return { error: 'missing-args', need: ['targetRepoRoot', 'cli', 'ref'], got: Object.keys(A) }

// Clamp a seam-agent's output to a single stdout string.
const RawSchema = { type: 'object', additionalProperties: false, properties: { stdout: { type: 'string' } }, required: ['stdout'] }
const safeParse = (s) => { try { return JSON.parse(String(s).trim()) } catch (e) { return { _parseError: String(e), raw: String(s).slice(0, 400) } } }
const J = (o) => JSON.stringify(o)

// A SEAM: a cheap one-shot courier that runs ONE CLI command verbatim and returns
// its single JSON line. The courier does zero reasoning, so its model is chosen by
// seam kind to trim the harness-instantiation tax. Mirrors run.workflow.js:
// - read-only / idempotent seams (retryable=true) run on HAIKU; a garbled relay
//   simply re-invokes, so the cheaper, marginally-garblier model costs only a rare retry.
// - MUTATING seams (adjudicate, writeLensVerdict) leave retryable=false and stay on
//   SONNET so a garble safely pauses rather than risk double-applying a mutation
//   (Haiku garbled exactly such a verdict relay on run 8.13).
const seam = async (cmd, label, retryable = false) => {
  const attempts = retryable ? 3 : 1
  let parsed = { _parseError: 'agent-null' }
  for (let a = 0; a < attempts; a++) {
    const r = await agent(
      `You are a deterministic command runner. Use the Bash tool to execute the command below EXACTLY as written. ` +
        `Hard rules: do NOT modify the command, do NOT change or "correct" any path, do NOT cd, do NOT read files, do NOT run anything else. ` +
        `It prints exactly one line of JSON to stdout — return that line verbatim in the "stdout" field.\n\nCOMMAND:\n${cmd}`,
      { schema: RawSchema, label, phase: 'gate-1', model: retryable ? 'haiku' : 'sonnet' },
    )
    parsed = r ? safeParse(r.stdout) : { _parseError: 'agent-null' }
    if (!parsed._parseError) return parsed
    if (a < attempts - 1) log(`seam ${label} garbled relay (attempt ${a + 1}/${attempts}) — retrying`)
  }
  return parsed
}

// Session id: prefer the launcher-minted id; fall back to minting one via the CLI.
const SU = A.sessionUlid || (await seam(`node ${CLI} mintSessionUlid`, 'mint', true)).sessionUlid
if (!SU) return { error: 'no-session-ulid' }
log(`readiness review session=${SU} repo=${REPO} ref=${REF}`)

// ---------------------------------------------------------------------------
// Read the draft spec text and manifest so we can pass it to the judges.
// ---------------------------------------------------------------------------
phase('mint')

// Resolve the lens→role binding from the live hired roster via the deterministic
// resolveLensRoles seam (Story FU2). Uses maximum bipartite matching so the binding
// is always injective (five distinct roles), preferring a specialist per lens when one
// is hired. Throws LensJudgeUnavailableError (surfaced as resolve-lens-roles-failed)
// when the roster is too small to staff all five judges. retryable=true: read-only.
const lensRolesResult = await seam(
  `node ${CLI} resolveLensRoles --json '${J({ targetRepoRoot: REPO })}'`,
  'resolve-lens-roles',
  true,
)
if (!lensRolesResult || lensRolesResult._parseError || lensRolesResult.error) {
  return {
    error: 'resolve-lens-roles-failed',
    detail: lensRolesResult?._parseError || lensRolesResult?.error || 'unknown',
    sessionUlid: SU,
    ref: REF,
  }
}
const lensRoles = lensRolesResult.lensRoles
log(`lens→role binding resolved: ${JSON.stringify(lensRoles)}`)

// Fetch the draft's spec text + persisted riskTier from the backlog inventory.
// We pass `ref` (single-item fetch) and `includeSpecText: true` so the tool reads
// the real source markdown (from the manifest's source_path, or the native-stories
// file) and returns it as `specText`. Without this the tool returns only
// ref/title/state — the judges then grade an empty `(spec text not available)`
// placeholder (the gate-1 spec-feed defect that wasted whole re-judge panels).
// `riskTier` is the Story 10.4 single source of truth when the manifest carries it.
// The tool returns `{ mode, backlog_inventory: [...] }` (NOT `items`).
const inventory = await seam(
  `node ${CLI} readBacklogInventory --json '${J({ targetRepoRoot: REPO, ref: REF, includeSpecText: true })}'`,
  'inventory',
  true,
)
let specText = ''
let riskTier = undefined
const invItem = Array.isArray(inventory?.backlog_inventory)
  ? inventory.backlog_inventory.find((i) => i.ref === REF)
  : undefined
if (invItem) {
  specText = invItem.specText || ''
  riskTier = invItem.riskTier
}
// Read the persisted lane from the inventory item (stamped at scan time by
// the lane classifier). Absent → resolveJudgePlan defaults to 'full' internally.
const persistedLane = invItem?.lane || undefined
// Fail loud rather than silently grade an empty spec — a blind panel is wasted
// tokens and a false verdict (no success-by-luck). The operator re-runs once the
// draft is scannable/readable.
if (!specText) {
  log(`ref=${REF} ABORTED — no spec text available to judge (readBacklogInventory returned no specText). Ensure the draft exists at its source_path and re-run.`)
  return {
    error: 'spec-text-unavailable',
    detail: `readBacklogInventory returned no specText for ref=${REF}; refusing to judge an empty draft.`,
    sessionUlid: SU,
    ref: REF,
  }
}

// Build the draft object that aggregateJudgePanel and the judges need.
// riskTier is the single source of truth (Story 10.4) when present; omitted
// lets the panel fall back to classifying from changedPaths (legacy).
const draft = {
  ref: REF,
  title: A.title || REF,
  specText,
  ...(riskTier !== undefined ? { riskTier } : {}),
}

// Build the judge persona prompt (shared across lenses — the per-lens rubric is
// appended per-spawn below).
const judgePersona = (await seam(`node ${CLI} buildPersonaSpawnPrompt --json '${J({ targetRepoRoot: REPO, role: 'generalist-reviewer' })}'`, 'persona:judge', true))?.systemPrompt || ''

// ---------------------------------------------------------------------------
// Resolve the judge plan from the persisted lane (+ detector_confirmed_dead).
// The load-bearing decision lives here — in a deterministic tool result, not
// in workflow JS or agent prose. resolveJudgePlan is a pure CLI seam:
//   full/absent → five-lens panel (current LENS_MODEL tiering, verbatim)
//   fast → one combined Structure+Verifiability lens on Sonnet
//   fast + detector_confirmed_dead=true → { skip: true } (auto-bless)
// ---------------------------------------------------------------------------
const judgePlanArgs = { storyId: REF, lane: persistedLane }
// detector_confirmed_dead is a future field; omitting it now defaults to false.
const judgePlanResult = await seam(
  `node ${CLI} resolveJudgePlan --json '${J(judgePlanArgs)}'`,
  'resolve-judge-plan',
  true,
)
if (!judgePlanResult || judgePlanResult._parseError || judgePlanResult.error) {
  return {
    error: 'resolve-judge-plan-failed',
    detail: judgePlanResult?._parseError || judgePlanResult?.error || 'unknown',
    sessionUlid: SU,
    ref: REF,
  }
}
const judgePlan = judgePlanResult
log(`judge plan for ref=${REF}: lane=${persistedLane || 'full'} skip=${judgePlan.skip} lenses=${JSON.stringify(judgePlan.lenses)}`)

// ---------------------------------------------------------------------------
// Auto-bless path: skip=true means the reachability auditor confirmed dead-code.
// Call adjudicateQualityLead directly with a synthetic clean panel so the bless
// brake fires through the normal path (ready + telemetry).
// ---------------------------------------------------------------------------
if (judgePlan.skip) {
  log(`ref=${REF} SKIP path — lane=fast+detector_confirmed_dead; bypassing judge panel, auto-blessing via adjudicateQualityLead.`)
  // Synthesise a minimal clean panel verdict (all lenses skipped → zero fails).
  const syntheticPanel = {
    ref: REF,
    sessionUlid: SU,
    lenses: [],
    passed: true,
    riskTier: riskTier || 'low',
  }
  const skipAdjudicateResult = await seam(
    `node ${CLI} adjudicateQualityLead --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, ref: REF, panel: syntheticPanel, round: 1, k: 1 })}'`,
    'adjudicate-skip',
  )
  const skipDecision = skipAdjudicateResult?.verdict?.decision
  log(`skip-path adjudication for ref=${REF}: decision=${skipDecision}`)
  return {
    sessionUlid: SU,
    ref: REF,
    decision: skipDecision || 'ready',
    riskTier: riskTier || 'low',
    lane: 'fast',
    skipped: true,
    perLens: [],
    failed: [],
  }
}

// ---------------------------------------------------------------------------
// Phase 2: fan out lens judges in PARALLEL via Promise.all.
// Fan-out is now driven by judgePlan.lenses (from resolveJudgePlan) rather than
// the hardcoded LENSES array. For lane=full this is the same five lenses at the
// same models. For lane=fast it is one combined Structure+Verifiability lens on
// Sonnet. Each judge is a short-lived read+write subagent whose only load-bearing
// act is calling writeLensVerdict --json exactly once.
// ---------------------------------------------------------------------------
phase('judge')
log(`fanning out ${judgePlan.lenses.length} lens judge(s) in parallel for ref=${REF}`)

// The rubric checks (abbreviated) per lens — enough for the judge to know what
// to grade. The full rubric lives in the planning artifacts; these are the Tier-1
// scoreable checks from rubric §3.
const LENS_RUBRIC = {
  structure: 'Grade against Structure lens (rubric §3.1): Given/When/Then ACs, task decomposition, no hidden coupling. Pass if the story is complete and self-contained; fail with the specific structural gap in `missed`.',
  verifiability: 'Grade against Verifiability lens (rubric §3.2): grade PINNABILITY-ONCE-BUILT — once the proposed work is built, could a correctly-written test be made to fail if the described behaviour were missing? A real FAIL is a success condition that can never be pinned even in principle (e.g. "status.*\\"failed\\"" — a string-presence check that proves nothing about behaviour). The fact that the code or test does not yet exist is NOT a fail — that is the normal, expected state of a plan. Do NOT fault net-new behaviour the plan proposes for not yet existing. A behaviour-pinning check is sound precisely when it would be unmet before the proposed change and met after it. Pass if each AC pins a behaviour that is verifiable once built; fail with the specific in-principle-unprovable AC in `missed`.',
  discipline: 'Grade against Discipline lens (rubric §3.3): one coherent concern per story, no scope creep, no premature abstraction. Pass if the story is disciplined; fail with the specific discipline breach in `missed`.',
  domain: 'Grade against Domain lens (rubric §3.4): technically accurate, no ungrounded claims, implementation is plausible. Pass if the domain is sound; fail with the specific inaccuracy in `missed`.',
  considered: 'Grade against Considered lens (rubric §3.5): failure modes addressed. For low-risk drafts: names what could break + pins top failure. For medium/high: cold-dev-sufficient (every open question has a defaulted answer). Pass if the bar is met; fail with the specific gap in `missed`.',
  // Fast-lane combined lens: Structure + Verifiability in one pass on Sonnet.
  // The two most COMMON author errors: malformed ACs and hollow-draft issues.
  'structure+verifiability': 'Grade against Structure lens (rubric §3.1) AND Verifiability lens (rubric §3.2) in a single combined pass. Structure: Given/When/Then ACs, task decomposition, no hidden coupling — fail if the story is not self-contained. Verifiability: grade PINNABILITY-ONCE-BUILT — once the proposed work is built, could a correctly-written test fail if the described behaviour were missing? Do NOT fault net-new behaviour for not yet existing. Fail if any AC success condition can never be pinned in principle. Write a SINGLE `missed` string covering all Structure and Verifiability gaps found (or "nothing missed" on a clean sweep). Pass only if BOTH lenses pass.',
}

const LENSES = ['structure', 'verifiability', 'discipline', 'domain', 'considered']

// Per-lens model tiering (operator decision 2026-06-02). The judge panel is the
// silent-failure gate, so we keep Opus on the three lenses where a miss is subtle
// and costly to catch downstream — Verifiability (does each AC pin observable
// behaviour?), Domain (technical accuracy), Considered (failure-mode/cold-dev
// sufficiency). The two most MECHANICAL lenses — Structure (well-formed
// Given/When/Then, decomposition) and Discipline (one coherent concern, no scope
// creep) — drop to Sonnet, where a loud, pattern-based check is adequate. This
// trims ~25-35% off the panel's cost (its largest spend bucket) while preserving
// gate depth where it matters. Validate against a known-hollow draft before fully
// trusting it: the deep lenses (esp. Verifiability) must still bounce it.
const LENS_MODEL = {
  structure: 'sonnet',
  discipline: 'sonnet',
  verifiability: 'opus',
  domain: 'opus',
  considered: 'opus',
}

// ---------------------------------------------------------------------------
// Assemble the shared judge context ONCE — outside the per-lens fan-out loop.
//
// Story native:01KTKK5NQWTV4NHB37V7WC6AD8: building the shared prefix once
// (persona + task preamble + spec + risk tier) and reusing it across all lenses
// lets the Workflow runtime share the prompt cache across sibling agent() calls
// rather than re-creating it five times at premium-model rates. The prefix is
// byte-identical across all lens prompts; only the per-lens suffix (lens name,
// role, rubric check, CLI command) differs. This is an assembly refactor —
// each lens still receives the full persona, spec, and rubric (content-preserving).
// ---------------------------------------------------------------------------

const sanitisedRef = REF.replace(/:/g, '-')
const riskLabel = riskTier || 'medium (fallback)'

// Shared prefix — built ONCE, reused for every lens.
const judgeSharedPrefix =
  `${judgePersona}\n\n` +
  `## Your task: grade a draft story against ONE lens\n\n` +
  `You are a lens judge for the readiness review panel. ` +
  `Your ONLY job is to grade the draft below against your assigned lens, ` +
  `then call the CLI tool to record your verdict. ` +
  `You MUST call writeLensVerdict exactly once and then stop — do NOT edit any files, do NOT run any other commands.\n\n` +
  `**Risk tier:** ${riskLabel}\n\n` +
  `**Draft spec:**\n\`\`\`\n${specText}\n\`\`\`\n\n`

log(`shared judge context assembled once for ref=${REF} (${judgePlan.lenses.length} lenses will reuse it)`)

const judgeResults = await Promise.all(
  judgePlan.lenses.map(async (lens) => {
    // For full lane: role from lensRoles[lens] (the five standard names).
    // For fast lane: the combined 'structure+verifiability' lens uses the
    // 'generalist-reviewer' role as a fallback (lensRoles won't have this key).
    const role = lensRoles[lens] || lensRoles['structure'] || 'generalist-reviewer'

    // Derive the verdict file path the judge MUST write to (mirrors lensVerdictFilePath
    // in judge-panel.ts — the panel reader expects exactly this path).
    // Path: <targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<sanitised-ref>/judge-<lens>.json
    // sanitiseRefForPathSegment replaces ':' with '-'; mirrors the TypeScript helper.
    const verdictFilePath = `${REPO}/.flow/state/sessions/${SU}/${sanitisedRef}/judge-${lens}.json`

    // Per-lens suffix — the only part that differs between lenses.
    // Contains: lens name, assigned role, rubric check, CLI command.
    // The sharedPrefix above already carries the persona, spec, and risk tier.
    const lensSuffix =
      `**Lens:** ${lens}\n` +
      `**Your role:** ${role}\n` +
      `**Rubric check:** ${LENS_RUBRIC[lens]}\n\n` +
      `**Required action — call this command exactly once:**\n` +
      `\`\`\`\n` +
      `node ${CLI} writeLensVerdict --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, ref: REF, lens, role, pass: '<true|false>', missed: '<non-empty string: "nothing missed" on pass, specific gap on fail>' })}'\n` +
      `\`\`\`\n\n` +
      `Replace \`"<true|false>"\` with the boolean \`true\` or \`false\` (no quotes). ` +
      `Replace \`"<non-empty string: ...>"\` with a plain string (never empty — even on a pass, write "nothing missed" or a brief summary of what you verified). ` +
      `The verdict is written to: \`${verdictFilePath}\``

    // Spawn the judge as a one-shot subagent. The judge's ONLY load-bearing act is
    // calling node CLI writeLensVerdict --json exactly once. Its reasoning is free;
    // only the verdict FILE is authoritative (deterministic-seam discipline).
    // The judgePrompt = sharedPrefix (byte-identical across siblings) + lensSuffix.
    const judgePrompt = judgeSharedPrefix + lensSuffix

    try {
      // Model is sourced from the resolved plan (judgePlan.perLensModel), not the
      // static LENS_MODEL constant — this handles both full and fast lane models.
      await agent(judgePrompt, { label: `judge:${lens}`, phase: 'judge', model: judgePlan.perLensModel[lens] || 'sonnet' })
    } catch (e) {
      log(`judge ${lens} agent threw: ${String(e)} — aggregation will fail loudly on the missing verdict file`)
    }

    return { lens, role, verdictFilePath }
  }),
)

log(`all ${judgePlan.lenses.length} lens judge(s) settled for ref=${REF}`)

// ---------------------------------------------------------------------------
// Phase 3: aggregate and adjudicate.
// aggregateJudgePanel reads the five per-lens verdict files, validates them
// against the schema, and returns the PanelVerdict. Then adjudicateQualityLead
// is called with round=1 and k=1: a clean panel yields decision=ready (blessed
// through the Story 9.1 brake), any lens fail yields decision=escalate
// immediately (not rework — the rework loop is the deferred follow-on).
// ---------------------------------------------------------------------------
phase('aggregate')

// aggregateJudgePanel: read + validate the five per-lens files, assemble the
// PanelVerdict, emit panel.graded telemetry. MUTATING reads (may fail on missing
// file → LensVerdictFileMalformedError surfaced loudly). retryable=false: if the
// relay garbles we surface the _parseError and stop.
const aggregateResult = await seam(
  `node ${CLI} aggregateJudgePanel --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, draft, lensRoles })}'`,
  'aggregate',
)
if (!aggregateResult || aggregateResult._parseError || aggregateResult.error) {
  return {
    error: 'aggregate-failed',
    detail: aggregateResult?._parseError || aggregateResult?.error || 'unknown',
    sessionUlid: SU,
    ref: REF,
  }
}
log(`panel aggregated for ref=${REF}: riskTier=${aggregateResult.riskTier}`)

// adjudicateQualityLead: apply rubric §5 synthesis with round=1 and k=1.
// With these values synthesiseDecision behaves:
//   - failed.length === 0 → decision=ready (clean sweep, blessed via brake)
//   - failed.length > 0 AND round >= k (1 >= 1) → decision=escalate (any fail immediately escalates)
// There is NO rework loop in this workflow. That is the deferred follow-on.
// MUTATING (blesses through markStoryReady brake on ready). retryable=false.
const adjudicateResult = await seam(
  `node ${CLI} adjudicateQualityLead --json '${J({ targetRepoRoot: REPO, sessionUlid: SU, ref: REF, panel: aggregateResult.verdict, round: 1, k: 1 })}'`,
  'adjudicate',
)
if (!adjudicateResult || adjudicateResult._parseError || adjudicateResult.error) {
  return {
    error: 'adjudicate-failed',
    detail: adjudicateResult?._parseError || adjudicateResult?.error || 'unknown',
    sessionUlid: SU,
    ref: REF,
    panelVerdict: aggregateResult.verdict,
  }
}

const decision = adjudicateResult.verdict?.decision
log(`adjudication for ref=${REF}: decision=${decision}`)

if (decision === 'ready') {
  log(`ref=${REF} BLESSED as ready — the draft cleared all five lenses and the Quality Lead adjudicated ready.`)
} else if (decision === 'escalate') {
  const reason = adjudicateResult.verdict?.escalation_reason || adjudicateResult.verdict?.rationale || 'see verdict'
  const failedLenses = aggregateResult.verdict?.lenses?.filter((l) => !l.pass).map((l) => `[${l.lens}] ${l.missed}`).join('; ')
  log(`ref=${REF} ESCALATED — one or more lenses failed (k=1, round=1 → immediate escalate). Failed lenses: ${failedLenses}. Operator: the readiness review did not pass — revise the draft and re-run /flow:ready <ref> to grade it again.`)
  log(`Escalation reason: ${reason}`)
} else {
  log(`ref=${REF} unexpected decision=${decision} — this workflow always uses round=1 k=1, so rework should never occur.`)
}

// Compact return. The full per-lens detail, escalation reason, and bless/escalate
// narration are already emitted via log() above, so the launcher does NOT need the
// verbose panelVerdict/adjudicationVerdict objects nor the duplicate lensResults —
// those re-bill the main-loop context on every turn. Return only the structured
// summary a launcher acts on: the decision, the risk tier, a one-line-per-lens
// pass/fail map, and the failed lenses with their `missed` reason.
return {
  sessionUlid: SU,
  ref: REF,
  decision,
  riskTier: aggregateResult.riskTier,
  perLens: aggregateResult.verdict?.lenses?.map((l) => ({ lens: l.lens, pass: l.pass })),
  failed: aggregateResult.verdict?.lenses?.filter((l) => !l.pass).map((l) => ({ lens: l.lens, missed: l.missed })),
}
