# Story 6.4: `/accept-proposal <id>` skill — diff-then-confirm gate

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **every retro proposal kind to flow through one user-gated apply path that shows me a diff and waits for my explicit yes before it touches anything canonical**,
So that **no rule, skill, persona, or team change ever lands silently — I see exactly what would change, I approve it, and re-running the command never double-applies or corrupts state**.

This is the keystone of Epic 6b. Epic 6a (Stories 6.1–6.3, shipped) makes a retro emit a single proposal markdown file under `.crew/retro-proposals/<ISO>.md` carrying typed proposals — but that output is inert: a human reads it and changes things by hand. This story builds the one apply gate every other 6b story plugs into. It deliberately ships **only the gate machinery** — locate a proposal by id, render a diff, require confirmation, dispatch to a per-type apply handler, commit through the plugin git wrapper, stamp the proposal `applied`, and no-op idempotently on re-run. The actual per-type mutations (rule registry, skill files, persona knowledge, team composition) are registered into this gate by later stories (rule apply in Story 6.5, skill applies in Story 6.7, persona-append in Story 6.9, team-change in Story 6.10). Until a handler is registered for a given proposal kind, accepting that kind fails closed with a clear "ships in Story 6.X" error rather than half-applying.

## Dependencies

- **Consumes the proposal artifact from Story 6.3** (shipped): the schema, the `.crew/retro-proposals/<ISO>.md` file shape, `parseRetroProposalFile`, and the per-proposal stable `id` (ULID). This story re-reads those files at apply time — the frontmatter is the source of truth, exactly as 6.3's Dev Notes anticipated.
- **No hard dependency on 6.1 or 6.2.** The gate operates on proposal files on disk; it does not need the retro analyst to be running.
- **Is a prerequisite for** the per-type apply stories (rule apply, skill applies, persona-append, team-change). Those stories register a handler into the seam this story defines; none of them can land before this gate exists.
- Ships before the rest of Epic 6b and is drained on its own (operator decision, 2026-05-31).

## Acceptance Criteria

**AC1 — locate a proposal by id across the retro-proposal files (integration):**

A locator resolves a proposal id to the single `.crew/retro-proposals/<ISO>.md` file that contains it, returning the file's absolute path, the parsed file, and the matched proposal object. It scans every proposal file in the directory, splits frontmatter, and re-reads each through the canonical `parseRetroProposalFile` parser (never the rendered body). An id that matches no proposal raises a typed `ProposalNotFoundError` naming the id and how many files were scanned. An id that somehow matches in two files raises a typed `AmbiguousProposalIdError` (ids are minted unique; a collision is a bug, not a silent pick-first). A vitest seeds two proposal files with several proposals and asserts: a known id resolves to the right file and proposal, an unknown id raises `ProposalNotFoundError`, and a duplicated id raises `AmbiguousProposalIdError`.
vitest: plugins/crew/mcp-server/src/tools/__tests__/accept-proposal.test.ts

**AC2 — preview renders a diff and mutates nothing without explicit confirmation (integration):**

The gate is two-phase and deterministic. Called without confirmation (`confirm` absent or false), it returns a preview carrying a human-readable diff of the proposed change and a status of `preview` — and writes no file, makes no commit, emits no telemetry, and leaves the working tree byte-identical. The diff text is produced by the proposal kind's registered apply handler (the gate itself renders nothing kind-specific). A vitest drives a located proposal through preview mode with an injected handler and asserts: the returned status is `preview`, the diff string is present, and a snapshot of the target files before and after the call is unchanged (no mutation, no commit, no telemetry event).
vitest: plugins/crew/mcp-server/src/tools/__tests__/accept-proposal.test.ts

**AC3 — on confirm, the change is applied, committed through the git wrapper, and stamped applied (integration):**

Called with `confirm: true`, the gate invokes the registered handler for the proposal's kind, then commits the handler's changed paths together with the proposal-file stamp in a single commit via the plugin's git wrapper (no direct shell git, no force/no-verify). On success it writes an `applied` block onto the matched proposal in the file frontmatter carrying `applied_at` (ISO-8601 UTC), `applied_sha` (the commit sha from the wrapper), and `idempotency_key` (the proposal's stable id). The proposal-file write goes through the canonical managed-fs guard with an MCP tool context. A vitest drives a fresh proposal end-to-end with an injected fake handler (that writes one known file and reports it) and asserts: the handler's file changed on disk, exactly one commit was made through the injected git seam carrying both the handler file and the proposal file, the proposal now has an `applied` block with all three fields, and the returned status is `applied` with the sha.
vitest: plugins/crew/mcp-server/src/tools/__tests__/accept-proposal.test.ts

**AC4 — re-accepting an already-applied proposal is an idempotent no-op (integration):**

Given a proposal whose frontmatter already carries an `applied` block, re-running the gate against that id — even with `confirm: true` — reads the block and returns an `already-applied` status naming the prior `applied_sha` and `applied_at`, while making no handler call, no file write, no commit, and no telemetry event. The check is on the persisted `applied` block, not in-memory state, so it survives across process boundaries (the drain and a fresh CLI invocation see the same answer). A vitest applies a proposal once, then invokes the gate again on the same id with `confirm: true` and asserts the second call mutated nothing, made no second commit, emitted no second telemetry event, and reported `already-applied` with the first run's sha.
vitest: plugins/crew/mcp-server/src/tools/__tests__/accept-proposal.test.ts

**AC5 — a successful apply emits exactly one `retro.proposal.applied` telemetry event (integration):**

A new closed-enum telemetry event type `retro.proposal.applied` is added to the telemetry discriminated union (`.strict()`, no fallback), carrying the proposal `id`, `proposal_type`, `applied_sha`, and `idempotency_key`. The gate emits exactly one such event on a successful apply and emits none on preview, on a declined apply, on an idempotent no-op, or on a fail-closed unregistered kind. A vitest drives one apply and asserts a single `retro.proposal.applied` event lands in telemetry with the right fields, and asserts no event is emitted for a preview-only call.
vitest: plugins/crew/mcp-server/src/tools/__tests__/accept-proposal.test.ts

**AC6 — an unregistered proposal kind fails closed with a story-pointer error (integration):**

The gate dispatches by `proposal.type` to a handler registry. For a proposal whose kind has no registered handler, the gate raises a typed `ProposalKindNotApplicableYetError` naming the kind and the story that will ship its apply path — before any preview is rendered or any state is touched. No file is written, no commit is made, no proposal is stamped. A vitest asserts that accepting a proposal of an unregistered kind raises this typed error and leaves the tree and telemetry untouched.
vitest: plugins/crew/mcp-server/src/tools/__tests__/accept-proposal.test.ts

**AC7 — the `/crew:accept-proposal` skill drives the two-phase confirm UX (artifact):**

A skill file defines the operator command `/crew:accept-proposal <id>`: it resolves status, calls the gate in preview mode, renders the returned diff to the operator, requires an explicit yes, and only then calls the gate with confirmation. Its frontmatter lists the gate tool in `allowed_tools`, and its body never instructs a direct file mutation or a direct git call — every mutation flows through the gate tool. The file exists at the skill path and is shaped like the other crew skills.
artifact: plugins/crew/skills/accept-proposal/SKILL.md

**AC8 — the gate tool is registered with the DomainError envelope and typed errors (artifact):**

The `acceptProposal` MCP tool is registered in the tool registry with the standard `DomainError` envelope, and its new typed errors (`ProposalNotFoundError`, `AmbiguousProposalIdError`, `ProposalKindNotApplicableYetError`) are defined in the errors module extending `DomainError`. The optional `applied` block is added to the proposal schema additively (an optional field on the proposal base — existing proposal files without it still parse cleanly; no existing schema is weakened).
artifact: plugins/crew/mcp-server/src/tools/register.ts

## Definition of Done

- [ ] All eight ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new test file covers every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean — AC1–AC6 are runnable vitest, AC7–AC8 are file-presence; the reviewer's runnable-AC pass should be all-green.
- [ ] No canonical-state mutation outside the gate's own surface: the only files this story's code writes are the proposal markdown (the `applied` stamp) and whatever an injected handler writes in a test. No production handler is registered in this story, so a real `/accept-proposal` on any kind fails closed until its handler story lands.
- [ ] Schema change is additive only — the existing seven-variant union and `.strict()` posture are preserved; the `applied` block is optional.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds (the gate):** the `acceptProposal` tool, the proposal locator, the two-phase preview/confirm contract, the per-type handler registry + interface, the single-commit apply through the git wrapper, the `applied`-block stamp, the idempotency no-op, the new telemetry event, the typed errors, and the `/crew:accept-proposal` skill.

**Does NOT build (deferred to handler stories):** any real rule-registry mutation (Story 6.5), any skill-file create/revise/supersede/retire (Story 6.7), any persona-knowledge append (Story 6.9), any team hire/unhire (Story 6.10), `docs/standards.md` regeneration (Story 6.5b). In this story the production handler registry is **empty** — every kind fails closed via AC6. The gate is proven end-to-end with a **test-injected fake handler**, not a real one. This keeps the keystone laser-focused and gives each later story a crisp seam to register into, with no throwaway "minimal handler" for a later story to rewrite.

This "pure gate + injected handler for tests" decomposition is a deliberate choice (operator-confirmed 2026-05-31). The epic's AC4-test clause ("drives accept-proposal against a fresh rule proposal") is honoured by making the test's proposal a `rule`-typed proposal with an injected fake rule handler — the proposal is genuinely a rule proposal; only the apply handler is a test double. Record this decision in the completion notes so the reviewer reads AC3 against an injected handler, not a real rule mutation.

### The handler seam (binding shape)

Define a `ProposalApplyHandler` interface and a registry keyed by `proposal.type`. Each handler owns two operations: render a diff preview for a proposal, and apply it (returning the list of repo-relative paths it changed, so the gate can commit them). The gate is kind-agnostic — it never reads kind-specific fields; it only calls the handler.

```ts
export interface ProposalApplyResult {
  changedPaths: string[];        // repo-relative; gate commits these + the proposal file
}
export interface ProposalApplyHandler {
  readonly type: RetroProposal["type"];
  previewDiff(proposal: RetroProposal, ctx: HandlerContext): Promise<string>;
  apply(proposal: RetroProposal, ctx: HandlerContext): Promise<ProposalApplyResult>;
}
```

- The registry is a `Map<type, handler>`. Production registry is empty in this story.
- The `acceptProposal` tool takes an **optional `handlers` injection** (defaulting to the production registry), mirroring the `execaImpl` injection pattern already used by the git wrapper. Tests pass a fake handler; production passes nothing.
- Unregistered kind → `ProposalKindNotApplicableYetError(kind, "Story 6.X")`. Map each kind to its planned story so the message is actionable: `rule`/`rule-retirement` → Story 6.5, the four `skill-*` kinds → Story 6.7, `team-change` → Story 6.10, persona-append (when 6.9 routes through here) → Story 6.9.

### The two-phase contract (deterministic-seam discipline)

A subagent/CLI cannot hold an interactive prompt, so the confirm gate is modelled as two tool calls, not a blocking prompt — the load-bearing decision lives in the tool layer, not skill prose:

- `acceptProposal({ targetRepoRoot, proposalId })` → `{ status: "preview", proposalId, type, diff }` (no mutation).
- `acceptProposal({ targetRepoRoot, proposalId, confirm: true })` → applies, commits, stamps, returns `{ status: "applied", appliedSha, idempotencyKey }`.
- Re-run on an applied id → `{ status: "already-applied", appliedSha, appliedAt }` (no mutation).

The skill orchestrates: preview → show diff → ask the operator → on an explicit yes, call again with `confirm: true`. The skill is the UX; the tool is the gate. A declined apply is simply "the operator never makes the confirm call" — no state changed, fully re-runnable (this is the epic's "refused apply" path; AC2 pins the preview-only no-op).

### The `applied` block + idempotency

- Add an optional `applied` block to the proposal base schema in the retro-proposal schema module — additive, optional, `.strict()`-compatible (existing files without it still parse). Shape: `{ applied_at: ISO-8601 UTC, applied_sha: string, idempotency_key: ULID }`.
- The stamp lives on the **individual proposal** in the `proposals[]` array (a file can hold several proposals, accepted independently), not at file level.
- `idempotency_key` is the proposal's stable `id` — re-runs match on the persisted block. A content-hash is acceptable if the dev prefers tamper-evidence, but the id suffices for NFR10; say which was chosen in the completion notes.
- Stamping = split frontmatter, `yaml.parse`, set `proposals[i].applied`, `yaml.stringify({ lineWidth: 0 })`, reassemble `---\n<fm>---\n\n<body>`, write through the managed-fs guard. The other proposals in the file must round-trip byte-stably.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/tools/accept-proposal.ts` — the gate tool.
- `plugins/crew/mcp-server/src/lib/proposal-apply-registry.ts` — the `ProposalApplyHandler` interface + registry + `ProposalKindNotApplicableYetError` story-pointer map.
- `plugins/crew/mcp-server/src/lib/locate-proposal.ts` — the id locator (scan + parse + match), or co-locate in `accept-proposal.ts` if cleaner.
- `plugins/crew/mcp-server/src/tools/__tests__/accept-proposal.test.ts` — AC1–AC6.
- `plugins/crew/skills/accept-proposal/SKILL.md` — the operator skill (AC7).

**UPDATE:**
- `plugins/crew/mcp-server/src/schemas/retro-proposal.ts` — add the optional `applied` block to the proposal base (additive).
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — add the `retro.proposal.applied` event variant to the discriminated union (AC5).
- `plugins/crew/mcp-server/src/tools/register.ts` — register `acceptProposal` (AC8). Group with the other retro-path registrations.
- `plugins/crew/mcp-server/src/errors.ts` — add `ProposalNotFoundError`, `AmbiguousProposalIdError`, `ProposalKindNotApplicableYetError` (mirror the existing `RetroProposalAlreadyExistsError` constructor pattern).

### Existing seams to wire into (do not reinvent)

- **Git wrapper:** `gitCommit({ targetRepoRoot, paths, message, role, execaImpl? })` in `plugins/crew/mcp-server/src/lib/git.ts`. Returns `{ commitSha }`. Use `messageShape: "plugin-internal"` with a kebab message (e.g. `accept-proposal: <id>`). It refuses `--force`/`--no-verify` by construction. Inject `execaImpl` in tests.
- **Telemetry:** `logTelemetryEvent({ targetRepoRoot, event })` in `plugins/crew/mcp-server/src/lib/logger.ts`. It stamps `ts`, validates against the union, and appends one JSONL line. Mirror the call shape used by `post-reviewer-comments.ts`.
- **Managed-fs guard:** `writeManagedFile({ absPath, contents, targetRepoRoot, mcpToolContext: { toolName, role } })` in `plugins/crew/mcp-server/src/lib/managed-fs.ts`. The proposal path under `.crew/retro-proposals/**` is canonical, so the `mcpToolContext` is required.
- **Frontmatter helpers:** `splitFrontmatter(raw, sourcePath)` in `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts`, plus `parse`/`stringify` from the `yaml` package (`lineWidth: 0` for byte-stable output).
- **Proposal parse + types:** `parseRetroProposalFile` and `RetroProposal` in `plugins/crew/mcp-server/src/schemas/retro-proposal.ts`. The locator pattern to mirror is the done-manifest scan in `plugins/crew/mcp-server/src/tools/gather-retro-inputs.ts` (list a dir, parse each file, collect).
- **Skill shape:** mirror `plugins/crew/skills/retro/SKILL.md` (frontmatter `name`, `description`, `allowed_tools`; prose body that calls the MCP tool by name; a status check first).
- **Idempotency precedent:** the manifest-marker no-op in `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (read a persisted marker, early-return if present) is the pattern for AC4.

### Edge cases worth surfacing in dev/review

- **Empty/absent retro-proposals dir.** Locating any id when `.crew/retro-proposals/` is empty or missing must raise `ProposalNotFoundError`, not crash — the operator gets a clean message.
- **Partial-failure atomicity.** If the handler's `apply` succeeds but the commit fails, do NOT stamp the proposal `applied` (a stamp with no commit would make a real change un-repeatable). Order: handler apply → write the applied-stamp into the proposal file (in memory / staged) → commit handler-paths + proposal-file together → only then return `applied`. If the commit throws, surface the error and leave the proposal un-stamped so a re-run is clean. Note the chosen ordering in completion notes; a reviewer should be able to see that a failed commit leaves no half-applied stamp.
- **`yaml` round-trip stability.** Re-stamping one proposal must not reorder or reformat the others. Pin this with the byte-stable `lineWidth: 0` serialization and, ideally, a test asserting the untouched proposals are unchanged.
- **No production handler is a feature, not a gap.** A reviewer might flag "the gate can't apply anything." That is correct for this story — AC6 makes it explicit and fail-closed. The first real handler arrives in Story 6.5.

### Risk + build notes (drain context)

- This is a `medium`-risk change: it introduces the canonical-state mutation gate (commits, stamps) and a new telemetry event, even though no production handler is wired yet. Expect the auto-merge gate to **pause for a human merge** — that is the intended outcome for this story, not a failure.
- Code change touching tool + schema + telemetry seams: rebuild and commit `dist/` in the same change; run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. Keep the diff scoped to the files above.
- Do not write or edit any execution manifest or `.crew/state` file — the tools own that ledger. The only `.crew` surface this story writes is `.crew/retro-proposals/<ISO>.md` (the `applied` stamp) and `.crew/telemetry` (via the logger).

### References

- Epic 6b framing and the per-tier handler split: the Epic 6 epic file, Story 6.4 block and the 2026-05-27 phasing note.
- Proposal artifact shape and `parseRetroProposalFile`: Story 6.3 (shipped) — `_bmad-output/implementation-artifacts/6-3-retro-proposal-markdown-with-seven-proposal-types.md`.
- Unified gate requirement: PRD FR61 (`/accept-proposal <id>` presents a diff and requires confirmation before mutating canonical state) and NFR10 (idempotent skill invocations). Architecture: `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md` ("All flow through the unified `/accept-proposal <id>` gate with diff-then-confirm").
- Deterministic-seam discipline (load-bearing decisions live in the tool layer, not prose): the project's standing principle; the two-phase confirm contract follows it.
