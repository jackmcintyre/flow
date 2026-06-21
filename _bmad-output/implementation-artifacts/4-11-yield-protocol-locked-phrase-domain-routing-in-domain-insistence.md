# Story 4.11: Yield protocol — locked phrase, domain routing, in-domain insistence

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **generalists in the dev/review loop to yield work to hired specialists when the work falls in a specialist's `domain:`, via a locked yield phrase that the runtime parses, with domain-based role lookup, in-domain insistence enforced in specialist personas, a routing-failure surface when no hired role matches, and a `yield.handoff` telemetry event on every successful handoff**,
so that **the "AI rubber-stamping AI" failure mode is structurally avoided — a generalist that lacks the depth to review (e.g.) auth code is forced to route the review to the hired security specialist instead of approving it itself**.

### What this story is, in one sentence

Add a pure `yield-parser.ts` that reads the reviewer subagent's transcript for the verbatim locked phrase `This sits in <domain>'s domain — handing off.`, a new MCP tool `processReviewerYield` that composes `yield-parser` + the existing `lookupRoleByDomain` (FR99) + `buildPersonaSpawnPrompt` to produce a specialist-reviewer spawn prompt or a routing-failure surface, extend the telemetry event schema with `yield.handoff` (emitted on the success branch only), pin the in-domain-insistence prose contract in every shipped specialist catalogue persona, fix the locked-phrase token name from `<role>` to `<domain>` across the catalogue and add a trailing period to match the epic AC, and ship a vitest suite covering the five branches AC6 enumerates against a fixture with a hired security specialist.

### What this story does (and why it needs its own story)

PRD `FR99/FR100/FR101/FR102/FR103/FR104/NFR29` pin the yield protocol's contract; architecture (`epic-4-dev-review-loop-the-engineering-heart` § "Yield protocol") names the locked phrase + the routing primitive + the telemetry requirement. Story 2.1 / 2.3 (catalogue + persona schemas) shipped the `domain:` frontmatter field and the `locked_phrases.yield` slot. Story 4.6 / 4.6b shipped the reviewer subagent path (`runReviewerSession` → `reviewer-result.json` → `processReviewerTranscript`). Story 4.7 shipped the verdict-marker idempotency contract. `lookupRoleByDomain` (Story 2.3) already implements the FR99 routing primitive — this story is the consumer that wires it into the reviewer path.

The yield protocol is the structural counter to the rubber-stamp failure mode (Epic 4 retro #80 / Story 4.6 lesson). Without it, the generalist reviewer is the sole gate for every PR — including PRs in domains where it has no depth (auth, threat models, accessibility, etc.). The fix is not to make the generalist smarter; it is to give the generalist a structural escape hatch ("this isn't my domain — route to the right specialist") and to make the specialist *unable* to defer back when the work IS in their domain (in-domain insistence). Together these two rules close the loop: every PR ends up reviewed by the right specialist for its content, not by whoever the dev session happened to spawn first.

This story owns four deliverables that go together:

1. **The parser** (`yield-parser.ts`). A pure function that mirrors `handoff-parser.ts`'s shape: split transcript into lines, find the last non-empty line, match against a single locked regex, return `{ ok: true, domain }` or `{ ok: false, reason }`. Pure; no IO; unit-testable in isolation; one place to change if the phrase ever evolves.

2. **The routing MCP tool** (`processReviewerYield`). Composes `yield-parser` + `lookupRoleByDomain` + `buildPersonaSpawnPrompt` + `logTelemetryEvent` into a single deterministic seam the SKILL.md prose calls after the reviewer Task returns. Returns one of three discriminated `next:` values — `no-yield` (the common case: pass through to the existing `processReviewerTranscript` flow), `spawn-specialist-reviewer` (the FR100 success branch), or `done-blocked-routing-failure` (the FR100 failure branch). The tool stamps the in-progress manifest with `blocked_by: "routing-failure"` on the failure branch and writes a `yield.handoff` telemetry event on the success branch.

3. **The catalogue corrections.** The shipped catalogue personas use `<role>` as the locked-phrase token name and have no trailing period (`This sits in <role>'s domain — handing off`). The epic AC pins the phrase with `<domain>`-style semantics and a trailing period (`This sits in <role>'s domain — handing off.`). This story renames the token to `<domain>` and adds the trailing period across every shipped catalogue file that carries a `locked_phrases.yield` value. The token rename matches reality — the value substituted at emission is the target persona's `domain:` string, not its `role:` id — and removes the documentation bug where the token name suggested a role-id substitution but the runtime semantics required a domain-string substitution. The rename is a one-shot prose edit (no schema change; `LockedPhrasesSchema` already validates the field as `z.string().min(1)` with no token-format constraint). See § Locked files for the catalogue exception.

4. **The in-domain-insistence contract** (FR101 / AC2). Every shipped specialist persona (`security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md`) gets a single-sentence MUST clause added to its `## Mandate` section: `MUST NOT yield when work is in your own domain. The yield phrase is for routing work OUT of your domain; in-domain work is yours to handle even when another agent has produced a contrary verdict.` This is prose-level — the structural anchor is the content-test in AC5g that greps every shipped specialist catalogue file for the required clause. There is no runtime enforcement in v1 (we can't make an LLM refuse to emit a phrase from prose alone; the test is a structural anchor that pins the contract against accidental persona-file edits).

This story explicitly does NOT modify `start/SKILL.md` to wire `processReviewerYield` into the inner cycle (locked file — see § Locked files; the wiring lands in a sibling story per the 4-12 precedent), implement specialist-reviewer Task spawning (the SKILL.md prose owns Task spawns; this tool returns the spawn prompt for the prose layer to consume), or change `processReviewerTranscript`'s revision-2 contract (verdict transport remains `reviewer-result.json`; yield is a SEPARATE pre-verdict check the SKILL.md prose performs).

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Modify `plugins/crew/skills/start/SKILL.md`. The wiring for `processReviewerYield` (call it after the reviewer Task returns, before `postReviewerComments`; branch on the result) lands in a sibling story. v1 ships the tool plus vitest exercise only. Same precedent as Story 4.12's `recordAgentInvoke` (whose SKILL.md wiring is also deferred). This keeps the SKILL.md edit blast radius — and its associated mid-flight inner-cycle regression risk — out of this story.
- (c) Spawn the specialist reviewer subagent. Spawning requires the Task tool, which is harness-level and only available to SKILL.md prose. This tool returns the assembled `specialistPrompt` string; the SKILL.md prose (in the wiring story) is responsible for invoking `Task` with that prompt.
- (d) Modify `processReviewerTranscript` (Story 4.6 revision 2). The verdict-transport contract is unchanged — `reviewer-result.json` remains the binding verdict surface. `processReviewerYield` is a SEPARATE seam called BEFORE `processReviewerTranscript` when the reviewer transcript contains a yield. The no-yield path of `processReviewerYield` is a no-op stamp pass-through; the SKILL.md prose proceeds to `processReviewerTranscript` as today.
- (e) Add specialist-reviewer verdict-transport. The yield protocol routes the review *invocation*; the specialist reviewer writes its OWN `reviewer-result.json` (the existing rev-2 contract is reused). A specialist that runs `runReviewerSession` produces the same JSON shape — no schema change. If a hired specialist's persona does NOT include `runReviewerSession` in `tools_allow`, that's a hiring/catalogue gap, not a 4-11 problem; the no-session-result blocked branch surfaces it.
- (f) Implement an n-deep yield chain. v1 supports exactly ONE yield per review cycle: generalist-reviewer yields → specialist reviews → verdict. A specialist that itself yields (specialist A says "this sits in B's domain") triggers `done-blocked-routing-chain-too-deep` — out of scope; this story rejects chain depth > 1. (See AC1g for the structural assertion.)
- (g) Add a `yield.routing_failure` telemetry event. Per NFR29's "every yield HANDOFF" wording, telemetry covers successful handoffs only. The failure branch's durable record is the `blocked_by: routing-failure` manifest stamp plus the chat-surface line; no JSONL entry. Adding a failure-event in a future epic is additive (extend the closed union, emit on the failure path) — not a v1 requirement.
- (h) Touch `permissions/generalist-dev.yaml`. The dev subagent does not call `processReviewerYield`; the SKILL.md prose does (when wiring lands). `permissions/generalist-reviewer.yaml` is also unchanged — the reviewer doesn't call it either; the prose layer does.
- (i) Refactor `lookupRoleByDomain`. The existing tool (Story 2.3) is consumed as-is. The pre-existing first-encountered-on-collision behaviour (filesystem traversal order) is preserved; if a future story decides domain collisions need a routing-ambiguity diagnostic, that's an additive change in that tool, not here.
- (j) Modify `lib/logger.ts`. The closed discriminated-union dispatch already handles new event types via the schema. Same precedent as Story 4.12 Task 1.4.
- (k) Add configuration knobs. The locked yield phrase, the `<domain>` token, and the chain-depth cap (1) are hardcoded constants. No `.crew/config.yaml` override surface in v1.
- (l) Drift detection — i.e. emitting a typed error when a reviewer says something *close to* the yield phrase but not exactly. v1's parser treats any non-matching last line as `no-yield` (silently pass through). A misspelled yield attempt looks the same as no yield. Operator inspection of the reviewer's chat is the surface for that diagnosis; a future story can add a "near-miss yield" diagnostic if it surfaces as a problem.
- (m) Change `lookup-role-by-domain.ts`'s `custom`/`_archived` skip-list. The existing exclusions are preserved verbatim.

### Deferred work

- **SKILL.md wiring for `processReviewerYield`.** Sibling story (likely 4-11b or rolled into 5.x's inner-cycle revision). The story is small (3–5 prose edits + branch handling) but its blast radius touches the dev/review loop's hot path, which warrants its own ship cycle with its own integration test.
- **Specialist-reviewer Task spawning.** Belongs in the same SKILL.md-wiring sibling story above.
- **n-deep yield chains.** A specialist that itself yields is rejected in v1 (chain-too-deep). Future support requires tracking yield depth across the inner cycle and a sensible cap (probably 2 — generalist → specialist-A → specialist-B → halt).
- **`yield.routing_failure` telemetry event.** Failure path is currently chat-surface + manifest stamp only. Adding a JSONL entry is additive.
- **Routing-ambiguity diagnostic.** Story 2.1 AC3 forbids domain collisions at catalogue authoring time, but a hand-edited persona could introduce one. `lookupRoleByDomain` currently returns the first encountered role; v1 does not warn. Future enhancement to that tool.
- **Near-miss yield diagnostic.** Operator visibility into "reviewer attempted to yield but got the phrase wrong" — out of scope; manual transcript inspection is the v1 surface.

---

## Acceptance Criteria

> AC1–AC5 are verbatim from the epic. AC6 is the integration suite. None reference a slash command, operator-typed CLI, install-doc path, or Claude Code UI element — they describe internal yield-parser behaviour, an MCP routing tool, a persona-prose contract, a telemetry event, and a vitest fixture. Per `plugins/crew/docs/user-surface-acs.md`, this story is **substrate**; no `(user-surface)` tags apply.

**AC1:**
**Given** a generalist reviewer encountering work inside a hired specialist's `domain:`,
**When** it emits the locked yield phrase `This sits in <role>'s domain — handing off.`,
**Then** the runtime looks up the role by exact-match domain, spawns the specialist reviewer subagent with a clean context, and routes the review. _(FR99, FR100, FR102)_

<!-- Not user-surface: AC1 describes the SKILL-prose-driven Task spawn AFTER the runtime's MCP tool (`processReviewerYield`) returns a spawn prompt. No operator surface in the AC itself — the operator sees only the eventual specialist verdict on the PR, which is downstream of Story 4.6b's PR comment seam. -->

**AC2:**
**Given** a specialist asked to defer inside its own domain,
**When** the specialist runs,
**Then** it refuses to defer even when another agent has produced a contrary verdict (in-domain insistence). _(FR101)_

<!-- Not user-surface: AC2 is a persona-prose contract enforced by the specialist's mandate. The structural anchor is the catalogue-content test (AC6 sub-case "in-domain insistence prose"); the behavioural property is non-deterministic LLM behaviour shaped by the locked mandate phrasing. -->

**AC3:**
**Given** a yield whose named role has no hired match,
**When** the runtime looks up the domain,
**Then** the yield surfaces as `[routing-failure] no hired role matches domain "<x>"` on the orchestration surface; the story is blocked with `blocked_by: routing-failure`. _(FR100)_

<!-- Not user-surface: AC3's surface is the chatLog line returned by the MCP tool plus the manifest stamp. The operator eventually observes the blocked manifest via `/crew:status` (Story 1.7) but that's downstream of this story. -->

**AC4:**
**Given** any yield,
**When** routing succeeds,
**Then** a `yield.handoff` telemetry event records both roles and the triggering domain. _(FR103, NFR29)_

<!-- Not user-surface: AC4 describes a JSONL line written to `.crew/telemetry/<YYYY-MM>.jsonl`. Internal observability data. -->

**AC5:**
**Given** work where no hired specialist's domain matches,
**When** the generalist runs,
**Then** the generalist handles the work without yield. _(FR104)_

<!-- Not user-surface: AC5 is the no-yield pass-through. The reviewer continues to its normal verdict flow (Story 4.6 revision 2); the existing inner cycle is unchanged. No new operator surface. -->

**AC6 (integration):**
vitest covers the five yield branches against a fixture with a hired security specialist.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

### Expanded acceptance specifics (folded into AC1–AC6 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** Yield phrase, parser, and `processReviewerYield` success branch:

- (1a) **Token-name correction.** The locked yield phrase is `This sits in <domain>'s domain — handing off.` (trailing period; placeholder token name `<domain>`, NOT `<role>`). The epic AC's `<role>` placeholder name is a documentation artefact; the value substituted at emission is the target persona's `domain:` string, not its `role:` id. Renaming the token to `<domain>` in the shipped catalogue files removes the semantic mismatch. The runtime's parser extracts the substring between `This sits in ` and `'s domain — handing off.` and treats it as a domain string fed to `lookupRoleByDomain`. The epic AC text is preserved verbatim above; the implementation pins `<domain>`.

- (1b) **Parser shape.** New file `plugins/crew/mcp-server/src/skills/yield-parser.ts`. Pure function `parseYield(transcript: string): YieldParseResult`. `YieldParseResult = { ok: true; domain: string } | { ok: false; reason: "drift" | "empty" | "no-yield" }`. Mirrors `handoff-parser.ts`'s style: split on `\n`, trim trailing whitespace per line, find last non-empty line, exact-match the regex.

- (1c) **Parser regex.** `^This sits in (.+)'s domain — handing off\.$` — applied via `RegExp.prototype.exec` on the last non-empty line. The em-dash `—` (U+2014) is part of the literal; en-dash and hyphen do NOT match. The trailing period is part of the literal. Case-sensitive: `this sits in` does NOT match. Group 1 captures the domain string. If the captured domain is empty (the regex's `.+` prevents this, but belt-and-suspenders): return `{ ok: false, reason: "drift" }`.

- (1d) **Parser reason discriminator.** Empty/all-whitespace transcript → `{ ok: false, reason: "empty" }`. Last non-empty line that does NOT match the regex AND does NOT contain the substring `sits in` → `{ ok: false, reason: "no-yield" }`. Last non-empty line that contains `sits in` but doesn't match the full regex → `{ ok: false, reason: "drift" }`. The `no-yield` vs `drift` distinction is a v1 best-effort diagnostic — both currently route to the same `next: "no-yield"` MCP-tool result, but exposing them in the parser keeps the diagnostic available for future drift-surface stories without a parser refactor.

- (1e) **MCP tool: `processReviewerYield`.** Signature: `processReviewerYield(opts: { targetRepoRoot: string; sessionUlid: string; ref: string; fromRole: string; reviewerTranscript: string; manifestPath: string }): Promise<ProcessReviewerYieldResult>`. Pure-ish: reads `team/` via `lookupRoleByDomain`, reads the named persona via `buildPersonaSpawnPrompt`, writes telemetry on success, writes manifest on routing-failure. Algorithm: (i) call `parseYield`; (ii) if `ok: false`, return `no-yield`; (iii) if `ok: true`, call `lookupRoleByDomain({ targetRepoRoot, domain })`; (iv) if `role === null`, stamp manifest + return `done-blocked-routing-failure`; (v) if `role === fromRole` (the yielder named its own domain), reject as `done-blocked-routing-self-yield` (the in-domain insistence guard at the routing layer — see AC2c); (vi) else call `buildPersonaSpawnPrompt({ targetRepoRoot, role })`, emit `yield.handoff` event, return `spawn-specialist-reviewer`.

- (1f) **Result shape.**
  ```ts
  type ProcessReviewerYieldResult =
    | { next: "no-yield"; chatLog: string[] }
    | {
        next: "spawn-specialist-reviewer";
        toRole: string;
        specialistPrompt: string;
        chatLog: string[];
      }
    | { next: "done-blocked-routing-failure"; chatLog: string[] }
    | { next: "done-blocked-routing-self-yield"; chatLog: string[] };
  ```
  The SKILL.md wiring story consumes the discriminator; this story's tool exposes it.

- (1g) **Chain-depth cap (v1 = 1).** This tool is called by the SKILL.md prose AFTER the *generalist* reviewer's Task returns. The wiring story (not this story) is responsible for NOT calling `processReviewerYield` after a *specialist* reviewer Task returns — i.e. a specialist's transcript is never re-parsed for yields. This story's tool does not itself track depth; it accepts a `fromRole` parameter and the caller MUST pass the role that just ran. If the caller (in the future wiring story) accidentally calls this tool with `fromRole` set to a specialist role and the specialist yielded, the `done-blocked-routing-self-yield` branch (1e step v) catches the self-yield case; chain-depth-too-deep across distinct specialists is rejected by the wiring-story prose (out of scope here). This story's JSDoc on `processReviewerYield` documents the contract.

- (1h) **Spawn prompt assembly.** `buildPersonaSpawnPrompt` is called with the matched specialist role; the returned `systemPrompt` is passed back verbatim via `specialistPrompt`. No truncation, no header injection — the wiring story's `Task` invocation prepends the `initial_context` block in the same shape used for generalist reviewer spawns. If `buildPersonaSpawnPrompt` raises `PersonaFileNotFoundError` despite `lookupRoleByDomain` having found the role (race: persona deleted between the two calls), the error propagates verbatim — the operator sees a typed error rather than silent data corruption.

- (1i) **Chat-log line on success.** `chatLog` contains exactly one line: `yield routed — from <fromRole> to <toRole> on domain "<domain>" — spawning specialist reviewer (clean context)`. Verbatim format (asserted in vitest AC6 sub-case a).

**AC2 unpacked.** In-domain insistence prose contract + routing-layer self-yield guard:

- (2a) **Prose contract.** Every shipped specialist catalogue file (`security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md`) MUST include the exact sentence (verbatim, in its `## Mandate` section): `MUST NOT yield when work is in your own domain. The yield phrase is for routing work OUT of your domain; in-domain work is yours to handle even when another agent has produced a contrary verdict.` Insertion as the first or last bullet in the Mandate section is acceptable; the structural anchor test (2d) checks for the verbatim sentence anywhere within the Mandate.

- (2b) **Generalist personas are NOT changed by this clause.** `generalist-dev.md`, `generalist-reviewer.md`, `planner.md`, `hiring-manager.md`, `orchestrator.md`, `retro-analyst.md` do NOT receive the in-domain-insistence clause. The contract is specifically that *specialists* refuse to defer in their own domain; generalists are by definition out-of-domain on every domain.

- (2c) **Routing-layer self-yield guard.** `processReviewerYield` enforces a complementary structural rule at the routing layer: if `fromRole === toRole` (the yielding agent named its OWN domain via the resolved role lookup), the tool returns `done-blocked-routing-self-yield` with a chat line `[routing-failure] self-yield rejected — <role> attempted to yield to its own domain "<domain>"; in-domain insistence applies`. The manifest is stamped with `blocked_by: routing-self-yield`. This is the structural backstop for AC2 — even if a specialist's persona prose were edited to delete the in-domain-insistence clause, the routing layer would still refuse the self-yield. The two layers (prose contract + routing guard) are complementary: the prose stops the LLM from emitting; the routing guard stops bad emissions from being routed.

- (2d) **Structural anchor test (in AC6 sub-case f).** The vitest suite asserts (via `fs.readFile` + `string.includes`) that every shipped specialist catalogue file contains the verbatim sentence from (2a). The shipped catalogue list is enumerated explicitly in the test (no glob — adding a new specialist persona requires a deliberate edit to both the catalogue AND the test, which is the right friction). The four current specialists in scope: `security-specialist`, `test-specialist`, `docs-specialist`, `debugger`. Generalist roles are explicitly enumerated as MUST NOT contain the sentence (negative assertion).

- (2e) **No runtime test of LLM behaviour.** This story does not exercise a real LLM to confirm a specialist refuses to defer. The contract is structural (prose + routing guard); the in-domain insistence proper is non-deterministic LLM behaviour shaped by the locked mandate. The structural anchor + self-yield guard are the v1 guarantees.

**AC3 unpacked.** Routing-failure surface + manifest stamp:

- (3a) **Trigger condition.** Inside `processReviewerYield`: after `parseYield` returns `ok: true`, call `lookupRoleByDomain({ targetRepoRoot, domain })`. If the result is `{ role: null }`, route into the routing-failure branch.

- (3b) **Manifest stamp.** Read the in-progress manifest at `manifestPath` (passed by the caller — same shape as `processReviewerTranscript`'s `manifestPath` argument), set `blocked_by: "routing-failure"` (literal kebab-case string; pins the orchestration surface vocabulary), write back via `writeManifest`. The manifest stays in `in-progress/<ref>.yaml` — atomic move to `blocked/` is Story 5.1's responsibility (same precedent as the handoff-grammar drift case in `processDevTranscript`).

- (3c) **Chat-log line.** `chatLog` contains exactly one line: `[routing-failure] no hired role matches domain "<domain>" — story <ref> blocked. Clear blocked_by on the manifest and re-run /crew:start after hiring a role with this domain.` The bracketed `[routing-failure]` prefix and quoted domain string are verbatim (asserted in vitest AC6 sub-case b). The recovery hint (`re-run /crew:start`) is included so the operator has a runnable next step.

- (3d) **No telemetry event on failure.** Per NFR29's "every yield HANDOFF" wording, telemetry is for successful handoffs only. The durable failure record is the manifest stamp + the chat line. Adding a `yield.routing_failure` event is deferred (see § Deferred work).

- (3e) **No-op on already-stamped manifest.** If the manifest already carries `blocked_by: routing-failure`, the write is idempotent (the YAML round-trips byte-equal). No additional chat line, no error.

**AC4 unpacked.** `yield.handoff` telemetry event:

- (4a) **Schema entry.** New event in the closed discriminated union: `YieldHandoffEventSchema` with discriminator `"yield.handoff"`. `data: { from_role: z.string().min(1), to_role: z.string().min(1), domain: z.string().min(1) }`. `.strict()` on both event and data objects. Append to `TelemetryEventSchema` after the existing entries (Story 1.5 + 4.12's pattern; the union now totals 6 entries: `agent.invoke`, `telemetry.invalid`, `reviewer.verdict`, `reviewer.verdict.merge_action`, `dev.budget_exceeded`, `yield.handoff`).

- (4b) **Emission point.** Inside `processReviewerYield`'s success branch, AFTER `lookupRoleByDomain` returns a non-null role AND `buildPersonaSpawnPrompt` returns successfully, BEFORE the tool returns. Emit one `yield.handoff` event via `logTelemetryEvent`. Wrapped in try/catch — a telemetry-write failure MUST NOT prevent the spawn-prompt from being returned to the caller. The spawn-prompt assembly is the user-visible result; the telemetry write is the audit trail. On telemetry failure, the existing `telemetry.invalid` fallback path (Story 1.5) records the failure; the tool's return value is unaffected.

- (4c) **Event body.**
  ```ts
  {
    type: "yield.handoff",
    session_id: <sessionUlid>,
    agent: <fromRole>,        // e.g. "generalist-reviewer" — kebab-case (matches existing TelemetryEventBase.agent regex /^[a-z0-9-]+$/)
    story_id: <ref>,
    data: {
      from_role: <fromRole>,  // e.g. "generalist-reviewer"
      to_role: <toRole>,      // e.g. "security-specialist"
      domain: <domain>,       // verbatim from the matched persona's `domain:` field
    },
  }
  ```
  `agent` field at the event base level is set to `fromRole` for consistency with `agent.invoke`'s "who emitted this" semantics; the duplicated `data.from_role` field exists so consumers reading only `data` (e.g. retro tools projecting handoffs) don't need to climb up the event envelope.

- (4d) **No emission on `no-yield`, `done-blocked-routing-failure`, or `done-blocked-routing-self-yield`.** Telemetry covers successful handoffs only. The three non-success branches write no JSONL.

**AC5 unpacked.** No-yield pass-through:

- (5a) **Trigger condition.** `parseYield` returns `ok: false` (any reason: `empty`, `drift`, or `no-yield`).

- (5b) **Result.** `processReviewerYield` returns `{ next: "no-yield", chatLog: [] }`. No manifest writes; no telemetry. The chatLog is intentionally empty — the no-yield case is the COMMON path; surfacing a line for every non-yield review would pollute the operator's chat.

- (5c) **Downstream behaviour.** The SKILL.md wiring story (not this story) handles the `no-yield` branch by proceeding to the existing `postReviewerComments` → `processReviewerTranscript` flow unchanged. This story's tool does not itself drive that flow.

- (5d) **Empty-transcript guard.** If `reviewerTranscript` is empty or all-whitespace, `parseYield` returns `{ ok: false, reason: "empty" }` and this tool returns `no-yield`. No error. (The downstream `processReviewerTranscript` will route to `done-blocked-no-session-result` if the reviewer also skipped `runReviewerSession`, which is the correct surface for "reviewer ran but produced nothing useful".)

**AC6 unpacked.** Integration suite scope:

- (6a) **Fixture base.** vitest tests use `await fs.mkdtemp(path.join(os.tmpdir(), "yield-protocol-"))` per `beforeEach` to create a clean `targetRepoRoot`. `afterEach` cleans via `fs.rm(..., { recursive: true, force: true })`. No `import.meta.url` mocking. No mocking of `logTelemetryEvent`, `lookupRoleByDomain`, or `buildPersonaSpawnPrompt` — tests exercise the real implementations against tmpdir-seeded fixtures.

- (6b) **Fixture seeding helper.** A test-scoped helper `seedHiredTeam(targetRepoRoot, roles: Array<{ role; domain; lockedYield?; lockedHandoff?; lockedVerdict? }>)` writes a valid `PERSONA.md` per role into `<targetRepoRoot>/team/<role>/PERSONA.md` with the canonical sibling-of-catalogue shape (frontmatter + 5 required sections). Defaults: `model_tier: sonnet`, `tools_allow: [Read]`, `gh_allow: []`, `locked_phrases.handoff/yield/verdict` from the catalogue defaults (yield phrase: `This sits in <domain>'s domain — handing off.`), `hired_at: 2026-01-01T00:00:00Z`, `catalogue_version: 0.1.0`. The helper is used by every sub-case below.

- (6c) **Sub-case a: success branch.** Seed team with `generalist-reviewer` (domain `code review and verdict authoring`) and `security-specialist` (domain `authentication authorization and secret handling`). Seed an in-progress manifest at `<targetRepoRoot>/.crew/state/in-progress/native:01HZTEST.yaml`. Call `processReviewerYield({ ..., fromRole: "generalist-reviewer", reviewerTranscript: "Some reviewer prose.\n\nThis sits in authentication authorization and secret handling's domain — handing off." })`. Assert: return `{ next: "spawn-specialist-reviewer", toRole: "security-specialist", specialistPrompt: <non-empty string starting with "# Security Specialist — Persona">, chatLog: ["yield routed — from generalist-reviewer to security-specialist on domain \"authentication authorization and secret handling\" — spawning specialist reviewer (clean context)"] }`. Read the current month's JSONL; assert exactly one `yield.handoff` event with `data.from_role === "generalist-reviewer"`, `data.to_role === "security-specialist"`, `data.domain === "authentication authorization and secret handling"`. The manifest is unchanged from seed (no `blocked_by` stamp).

- (6d) **Sub-case b: routing-failure branch.** Seed team with `generalist-reviewer` only (no security-specialist). Call with the same `reviewerTranscript` as (6c). Assert: return `{ next: "done-blocked-routing-failure", chatLog: ["[routing-failure] no hired role matches domain \"authentication authorization and secret handling\" — story native:01HZTEST blocked. Clear blocked_by on the manifest and re-run /crew:start after hiring a role with this domain."] }`. Read the manifest; assert `blocked_by === "routing-failure"`. Assert no `yield.handoff` event in JSONL (and no JSONL file at all — telemetry directory should not be created on the failure path).

- (6e) **Sub-case c: self-yield branch.** Seed team with `security-specialist` (domain `authentication authorization and secret handling`). Call with `fromRole: "security-specialist"` and the same yield phrase that resolves to the security-specialist's own domain. Assert: return `{ next: "done-blocked-routing-self-yield", chatLog: ["[routing-failure] self-yield rejected — security-specialist attempted to yield to its own domain \"authentication authorization and secret handling\"; in-domain insistence applies"] }`. Manifest `blocked_by === "routing-self-yield"`. No telemetry event written.

- (6f) **Sub-case d: no-yield pass-through.** Seed team with `generalist-reviewer` + `security-specialist`. Call with `reviewerTranscript: "Normal reviewer output.\n\n**Verdict: READY FOR MERGE**"` (no yield phrase). Assert: return `{ next: "no-yield", chatLog: [] }`. Manifest unchanged. No JSONL file created.

- (6g) **Sub-case e: drift branch (silent pass-through).** Call with `reviewerTranscript: "This sits in the security specialist's domain - handing off."` (en-dash instead of em-dash; off-spec wording). Assert: return `{ next: "no-yield", chatLog: [] }`. Manifest unchanged. No JSONL. This is the intentional silent-pass-through v1 behaviour; operator inspection of the chat is the surface for diagnosing the misspelling.

- (6h) **Sub-case f: in-domain insistence prose anchor.** A separate `it()` block reads each of the four shipped specialist catalogue files (`plugins/crew/catalogue/security-specialist.md`, `.../test-specialist.md`, `.../docs-specialist.md`, `.../debugger.md`) via `fs.readFile`. For each, assert the file contains the verbatim sentence `MUST NOT yield when work is in your own domain. The yield phrase is for routing work OUT of your domain; in-domain work is yours to handle even when another agent has produced a contrary verdict.` via `string.includes`. Also assert each of the six generalist catalogue files (`generalist-dev.md`, `generalist-reviewer.md`, `planner.md`, `hiring-manager.md`, `orchestrator.md`, `retro-analyst.md`) does NOT contain the sentence (negative assertion — the contract is specialist-only).

- (6i) **Sub-case g: empty-transcript pass-through.** Call with `reviewerTranscript: ""`. Assert: return `{ next: "no-yield", chatLog: [] }`. No manifest write, no JSONL.

- (6j) **Sub-case h: malformed persona resolves to PersonaFileNotFoundError race.** Seed team with `security-specialist` per (6c) but delete the persona file between the `lookupRoleByDomain` call and the `buildPersonaSpawnPrompt` call. This is exercised by stubbing `lookupRoleByDomain` to return `{ role: "security-specialist" }` while no on-disk persona file exists. Assert: `PersonaFileNotFoundError` propagates verbatim. (Test ordering: this is in a separate `describe` block from the happy-path tests to keep the stub-vs-real boundary clear.)

- (6k) **Sub-case i: parser unit tests.** A separate `describe("parseYield")` block exercises the pure parser directly (no MCP tool): (i) verbatim match returns `{ ok: true, domain: "<value>" }`; (ii) en-dash returns `{ ok: false, reason: "drift" }`; (iii) missing trailing period returns `{ ok: false, reason: "drift" }`; (iv) case variation `this sits in <domain>'s domain — handing off.` (lowercase `t`) returns `{ ok: false, reason: "drift" }` — the regex is case-sensitive on the leading `T`, but the lowercase variant still contains the `sits in` substring, so the discriminator is `drift` not `no-yield`; (v) empty string returns `{ ok: false, reason: "empty" }`; (vi) whitespace-only returns `{ ok: false, reason: "empty" }`; (vii) yield phrase mid-transcript with different last line returns `{ ok: false, reason: "no-yield" }` (the last line lacks `sits in`); (viii) trailing whitespace on the yield-line is trimmed before matching.

- (6l) **Sub-case j: schema-strict assertion.** Attempt to write a `yield.handoff` event with an unknown extra key in `data` (e.g. `data.extra: "nope"`) via `logTelemetryEvent`. Assert `TelemetryEventInvalidError` thrown AND a `telemetry.invalid` event appears in the JSONL (existing Story 1.5 failure-recording path).

- (6m) **Sub-case k: round-trip JSONL parseability.** After a multi-event run (sub-cases a + c trigger two events: one `yield.handoff` and one no-op for the self-yield rejection, which writes no telemetry), read back the JSONL file and parse each line with `TelemetryEventSchema.safeParse`. Every line must `success: true`. (Same pattern as Story 4.12's AC5g.)

---

## Tasks / Subtasks

Implementation order is load-bearing. Each task lists its AC dependencies.

- [ ] **Task 1: Yield parser** (AC: #1)
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/skills/yield-parser.ts`.
  - [ ] 1.2 Export `parseYield(transcript: string): YieldParseResult` matching § AC1 unpacked (1b)–(1d).
  - [ ] 1.3 Export the locked-phrase template as `YIELD_PHRASE_TEMPLATE = "This sits in <domain>'s domain — handing off."` for use by persona renderers/tests.
  - [ ] 1.4 Export `YIELD_PHRASE_REGEX = /^This sits in (.+)'s domain — handing off\.$/` (also `as const` if it helps TS inference; otherwise plain const).
  - [ ] 1.5 JSDoc citing this story key, FR99, FR100, the locked-phrase invariant, and the `<domain>`-vs-`<role>` token-name correction.
  - [ ] 1.6 Create `plugins/crew/mcp-server/src/skills/__tests__/yield-parser.test.ts` covering AC6 sub-case (6k) — the parser unit tests.

- [ ] **Task 2: Extend telemetry event schema with `yield.handoff`** (AC: #4)
  - [ ] 2.1 In `plugins/crew/mcp-server/src/schemas/telemetry-events.ts`, append `YieldHandoffEventSchema` after the existing entries. Discriminator `"yield.handoff"`. `data: { from_role: z.string().min(1), to_role: z.string().min(1), domain: z.string().min(1) }`. `.strict()` on both event and data objects.
  - [ ] 2.2 Add `YieldHandoffEventSchema` to the `TelemetryEventSchema` discriminated union (now 6 entries total).
  - [ ] 2.3 Export the new schema and inferred type (`YieldHandoffEvent`).
  - [ ] 2.4 No behavioural change to `lib/logger.ts` — its discriminated-union dispatch already handles new event types via the schema.
  - [ ] 2.5 Add schema-strict tests to `plugins/crew/mcp-server/src/schemas/__tests__/telemetry-events-extension.test.ts` (Story 4.12 created this file; append a sub-describe for `yield.handoff`): (i) valid event parses; (ii) `.strict()` rejects extra keys on event and data; (iii) empty strings rejected on `from_role`/`to_role`/`domain`.

- [ ] **Task 3: Typed error for routing-self-yield (optional — caller-side guard)** (AC: #2)
  - [ ] 3.1 No new typed error class is required. The self-yield branch returns a `done-blocked-routing-self-yield` discriminator and stamps `blocked_by: routing-self-yield`; no error is thrown (it's a normal control-flow branch, not an exception). If a future story decides operator-surface telemetry is needed for self-yields, it can be added additively.

- [ ] **Task 4: `processReviewerYield` MCP tool** (AC: #1, #3, #4, #5)
  - [ ] 4.1 Create `plugins/crew/mcp-server/src/tools/process-reviewer-yield.ts`.
  - [ ] 4.2 Implement the algorithm per AC1 unpacked (1e): parseYield → if no-yield return; else lookupRoleByDomain → if no match stamp + return routing-failure; if self-yield stamp + return self-yield; else buildPersonaSpawnPrompt → emit telemetry → return spawn-specialist-reviewer.
  - [ ] 4.3 Emit `yield.handoff` event ONLY on the success branch (AC4 unpacked 4b). Wrap the `logTelemetryEvent` call in try/catch; on failure, log via the existing typed-error path and continue (return the spawn prompt regardless).
  - [ ] 4.4 Use `readManifest` / `writeManifest` from `lib/manifest-io.js` for the manifest stamp (same pattern as `processDevTranscript`).
  - [ ] 4.5 JSDoc cites this story key, FR99, FR100, FR101, FR102, FR103, FR104, NFR29, the chain-depth-cap-of-1 contract, and the self-yield guard.

- [ ] **Task 5: MCP-tool registration** (AC: all)
  - [ ] 5.1 Register `processReviewerYield` in `plugins/crew/mcp-server/src/tools/register.ts`. Bump any tool-count assertion in `__tests__/tool-registration.test.ts` (if present — search for "tool count" / "27"; 4.12 left it at 27, this story moves it to 28).
  - [ ] 5.2 Do NOT add `processReviewerYield` to any `permissions/*.yaml` file — the tool is called by SKILL.md prose (in the future wiring story), not by subagents. Same precedent as `processDevTranscript` / `processReviewerTranscript` (neither appears in subagent allowlists).

- [ ] **Task 6: Catalogue locked-phrase token rename + trailing-period fix** (AC: #1)
  - [ ] 6.1 Update every shipped `plugins/crew/catalogue/*.md` file whose frontmatter declares `locked_phrases.yield`: rename token `<role>` → `<domain>` and add the trailing period. Final string: `This sits in <domain>'s domain — handing off.`.
  - [ ] 6.2 Affected files (from catalogue audit): `generalist-reviewer.md`, `security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md`, `planner.md`, `orchestrator.md`, `retro-analyst.md`, `hiring-manager.md`, `generalist-dev.md`. Touch only the `locked_phrases.yield` value; preserve all other frontmatter and body content byte-equal.
  - [ ] 6.3 No persona-schema change. `LockedPhrasesSchema` already accepts the new string as `z.string().min(1)`. The token-placeholder regex enforcement (Story 4.3 Task 5's substitution-instruction line) extracts `<token>` patterns generically — renaming `<role>` to `<domain>` flows through `buildPersonaSpawnPrompt` without code change.
  - [ ] 6.4 Add a structural-anchor test (or extend an existing catalogue-content test) that asserts every shipped catalogue file's `locked_phrases.yield` value equals `YIELD_PHRASE_TEMPLATE` (imported from `yield-parser.ts`) — pins the lock against accidental drift.

- [ ] **Task 7: In-domain insistence prose contract** (AC: #2)
  - [ ] 7.1 Edit each shipped specialist catalogue file (`plugins/crew/catalogue/security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md`). In the `## Mandate` section, add the verbatim sentence (as a bullet, at the end of the list): `- MUST NOT yield when work is in your own domain. The yield phrase is for routing work OUT of your domain; in-domain work is yours to handle even when another agent has produced a contrary verdict.`
  - [ ] 7.2 Do NOT edit generalist catalogue files (`generalist-dev.md`, `generalist-reviewer.md`, `planner.md`, `hiring-manager.md`, `orchestrator.md`, `retro-analyst.md`). The contract is specialist-only.
  - [ ] 7.3 The structural anchor test (AC6 sub-case f) is implemented in Task 8.

- [ ] **Task 8: Integration test suite** (AC: #6)
  - [ ] 8.1 Create `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-yield.test.ts`. Implement sub-cases (6c)–(6g), (6i)–(6j), (6m) from AC6 unpacked.
  - [ ] 8.2 Add the in-domain insistence prose-anchor test as `plugins/crew/mcp-server/src/__tests__/in-domain-insistence-prose.test.ts` (sub-case (6h)). Lives under `src/__tests__/` (not `tools/__tests__/`) because it's a cross-catalogue contract test, not a per-tool test.
  - [ ] 8.3 Add the catalogue locked-phrase anchor test as `plugins/crew/mcp-server/src/__tests__/yield-phrase-locked.test.ts` (Task 6.4). Imports `YIELD_PHRASE_TEMPLATE` from `yield-parser.ts`; reads each shipped catalogue file via `gray-matter` (already used elsewhere — confirm via grep), asserts `data.locked_phrases.yield === YIELD_PHRASE_TEMPLATE`.
  - [ ] 8.4 All tmpdir fixtures MUST use `await fs.mkdtemp(path.join(os.tmpdir(), "yield-protocol-"))` — never bare string concatenation, never `${tmpdir()}/...` interpolation. (Pre-empt the Story 4-9 / 4-12 validator catch.)
  - [ ] 8.5 Zod-error-message assertions, if any, MUST use the Zod 4.x output format (`"Invalid option"` not v3's `"Invalid enum value"`). For literal custom errors prefer `{ message: "..." }` form, not v3's `errorMap`. (Pre-empt the Story 4-9 / 4-12 validator catch.)

- [ ] **Task 9: Build, vitest, dist** (AC: all)
  - [ ] 9.1 `pnpm --dir plugins/crew/mcp-server build` passes with no TypeScript errors.
  - [ ] 9.2 `pnpm --dir plugins/crew/mcp-server test` passes (existing 1077 tests from Story 4.12 + the new tests from this story; final total reported in the PR retro).
  - [ ] 9.3 Commit `plugins/crew/mcp-server/dist/` with rebuilt output. (Project rule: dist is tracked because `/plugin install` does not run a build step. See `plugins/crew/docs/README-install.md` § Build artefacts.)
  - [ ] 9.4 No leftover `TODO(4.11)` / `TODO(4-11)` comments in any touched source file.

---

## Implementation strategy

### Why the locked-phrase token is `<domain>`, not `<role>`

The epic AC says `This sits in <role>'s domain — handing off.` with `<role>` as the placeholder name. The runtime semantics — "look up the role by exact-match domain" — require the substituted value to be the persona's `domain:` string (a phrase like `authentication authorization and secret handling`), not its `role:` id (a kebab-case slug like `security-specialist`). The token name `<role>` in the epic AC is a documentation artefact that, if propagated to the shipped catalogue, would tell an LLM author to substitute the wrong value. Renaming the token to `<domain>` in the catalogue files (Task 6) matches reality and removes the trap. The epic AC text is preserved verbatim in the AC1 quote above so the AC-table gate can match the spec against the epic; the implementation pins `<domain>` as the operative token name. If a future epic-shard revision wants to align the AC text, that's an additive doc PR.

### Why `processReviewerYield` is a separate tool, not a branch inside `processReviewerTranscript`

Story 4.6 revision 2 pinned `processReviewerTranscript`'s contract: read `reviewer-result.json` and switch on `recommendedVerdict`. The reviewer's chat transcript is no longer consulted. Embedding yield-parsing inside `processReviewerTranscript` would re-introduce the dropped chat-parsing dependency and inflate `processReviewerTranscript`'s responsibilities (verdict routing AND yield routing — two orthogonal concerns). Keeping yield-parsing in a sibling tool means: (i) `processReviewerTranscript` remains a single-purpose function, (ii) the yield seam can be exercised by vitest in isolation, (iii) the SKILL.md wiring (in the future story) decides the call order — yield-check first, verdict-routing on no-yield. This mirrors the `processDevTranscript` shape (which routes between handoff-parse and recoverable-error-parse via discriminated returns).

### Why the SKILL.md wiring lands in a sibling story

Mirrors Story 4.12's precedent (`recordAgentInvoke` ships the tool; SKILL.md wiring is deferred). Three reasons: (i) the SKILL.md edit blast radius touches the dev/review loop's hot path, which warrants its own integration-test cycle; (ii) the tool's contract can be locked and exercised by vitest BEFORE the wiring story builds on it (parallelizes well with planned 5.x work); (iii) avoids coupling two distinct risks (substrate correctness + inner-cycle wiring correctness) into one PR review. The deferred work is small (≤ 5 prose edits + one new branch in the inner cycle) and tractable as a follow-up.

### Why the chain-depth cap is hardcoded to 1

A specialist that itself yields creates a routing chain. v1's user model is: generalist screens → specialist reviews → verdict. Allowing deeper chains opens questions (which specialist runs first? what does the chain look like to the operator?) that are out of scope for this story. The cap-at-1 simplification is documented in the JSDoc and enforced structurally by (a) the SKILL.md wiring story NOT calling `processReviewerYield` after a specialist Task returns, and (b) the routing-layer self-yield guard rejecting the trivial loop. Multi-specialist chain support is a deferred enhancement.

### Why telemetry covers success only

NFR29 says "every yield HANDOFF is recorded". The natural reading is: a handoff is the successful routing event. A routing failure (no hired match) is not a handoff — there is no second agent involved. The durable failure record is the manifest stamp + chat line + (eventually) the operator's `/crew:status` surface. Splitting `yield.routing_failure` into a separate event for downstream analytics is an additive future change; it's not load-bearing for the in-flight operator surface.

### Why the in-domain insistence contract is prose + routing-guard, not a runtime LLM check

There is no v1 way to make an LLM "refuse" to emit a phrase via runtime enforcement — the model's output is the model's output. Two complementary mechanisms close the gap: (a) the persona's mandate prose pins the rule into the system prompt that shapes the LLM's behaviour, and (b) the routing layer (`processReviewerYield`'s self-yield branch) rejects the bad emission if it happens anyway. Together they're a structural anchor: the prose discourages the emission; the routing guard catches the emission. Neither is sufficient alone; together they're the v1 contract. The structural-anchor test (AC6 sub-case f) protects (a) against accidental persona edits; the vitest sub-case (6e) protects (b) against accidental routing-guard regressions.

### Why no `permissions/*.yaml` changes

`processReviewerYield` is called by SKILL.md prose, not by subagents. The dev subagent (`generalist-dev`) never calls it. The reviewer subagent (`generalist-reviewer`) doesn't call it either — the SKILL.md prose calls it on the reviewer's behalf, AFTER the reviewer's Task returns. Same pattern as `processDevTranscript` / `processReviewerTranscript` / `claimNextStory` (none of which appear in subagent allowlists). When the wiring story lands, `start/SKILL.md`'s frontmatter `allowed_tools` line adds `processReviewerYield` — but that's an `allowed_tools` declaration on the skill, not a permission grant on a subagent.

### Why the no-yield branch is silent

Every PR not involving a domain-specialist hire goes through the no-yield branch (i.e. the common case). Surfacing a chat line ("no yield detected") on every review would pollute the operator's chat with non-actionable noise. The success branch's chat line and the failure branch's `[routing-failure]` line are both actionable; the no-yield branch is the default and produces nothing. The downstream `processReviewerTranscript`'s chat lines are unchanged and remain the operator's signal.

---

## Locked files

These files are off-limits to this story. If a change appears necessary, STOP and surface the conflict — do not silently edit.

- `plugins/crew/skills/start/SKILL.md` (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7) — DO NOT modify. The SKILL.md wiring for `processReviewerYield` lands in a sibling story; v1 ships the tool and the parser only.
- `plugins/crew/mcp-server/src/lib/logger.ts` (Story 1.5) — DO NOT modify. The discriminated-union dispatch already handles new event types via the schema; no logger change needed.
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 revision 2) — DO NOT modify. The revision-2 contract (read `reviewer-result.json`, switch on `recommendedVerdict`) is unchanged.
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Story 4.3b / 4.5 / 4.8b) — DO NOT modify. The dev transcript path is unrelated to the reviewer-side yield seam.
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Story 4.6) — DO NOT modify. The reviewer session writer (which produces `reviewer-result.json`) is unchanged; yield is a separate parser path on the chat transcript.
- `plugins/crew/mcp-server/src/tools/lookup-role-by-domain.ts` (Story 2.3) — DO NOT modify. Consumed as-is; first-encountered-on-collision behaviour preserved verbatim.
- `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts` (Story 4.2) — DO NOT modify. Consumed as-is; the existing `<token>` substitution-instruction line (Story 4.3 Task 5) already handles `<domain>` placeholders generically.
- `plugins/crew/mcp-server/src/tools/read-persona.ts` (Story 2.3) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Story 4.6b / 4.7 / 4.12) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts` (Story 4.8) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` / `claim-story.ts` (Story 4.1) — DO NOT modify.
- `plugins/crew/permissions/generalist-dev.yaml` / `generalist-reviewer.yaml` (Story 2.2 / 4.6 / 4.12) — DO NOT modify. `processReviewerYield` is not a subagent-callable tool.
- `plugins/crew/mcp-server/src/schemas/persona.ts` / `catalogue.ts` (Story 2.1 / 2.3) — DO NOT modify. `LockedPhrasesSchema` already accepts the renamed yield string; no schema change.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/schemas/telemetry-events.ts`** (Story 1.5; locked-by-default because the closed discriminated union is contract surface) — Task 2 appends `YieldHandoffEventSchema` to the closed union. Additive-extension pattern explicitly anticipated by the file's "Closed set in v1" docstring; same precedent as Story 4.12's three additions.
- **`plugins/crew/mcp-server/src/tools/register.ts`** (Story 1.4; locked due to tool-count assertion) — Task 5 registers one new tool. Bump the tool-count assertion in `__tests__/tool-registration.test.ts` from 27 to 28.
- **`plugins/crew/catalogue/*.md`** (Story 2.1; locked because the shipped catalogue is the canonical role definitions surface) — Task 6 renames the locked-phrase token `<role>` → `<domain>` and adds the trailing period across every shipped catalogue file that carries a `locked_phrases.yield` value (frontmatter-only edit; no body changes). Task 7 adds the in-domain insistence sentence to each shipped specialist catalogue file's `## Mandate` section (body-only edit; no frontmatter changes). Together these are the smallest possible catalogue surface needed to deliver AC1 and AC2; no other catalogue content is touched.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/skills/yield-parser.ts` (Task 1.1)
- `plugins/crew/mcp-server/src/skills/__tests__/yield-parser.test.ts` (Task 1.6)
- `plugins/crew/mcp-server/src/tools/process-reviewer-yield.ts` (Task 4.1)
- `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-yield.test.ts` (Task 8.1)
- `plugins/crew/mcp-server/src/__tests__/in-domain-insistence-prose.test.ts` (Task 8.2)
- `plugins/crew/mcp-server/src/__tests__/yield-phrase-locked.test.ts` (Task 8.3)

### Files this story will modify

- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — Task 2.1–2.3 (append `YieldHandoffEventSchema`).
- `plugins/crew/mcp-server/src/schemas/__tests__/telemetry-events-extension.test.ts` — Task 2.5 (append sub-describe for `yield.handoff`).
- `plugins/crew/mcp-server/src/tools/register.ts` — Task 5.1 (register `processReviewerYield`).
- `plugins/crew/mcp-server/src/tools/__tests__/tool-registration.test.ts` (or the equivalent count-assertion test, if present) — Task 5.1 (bump 27 → 28).
- `plugins/crew/catalogue/generalist-reviewer.md` — Task 6 (token rename + trailing period in `locked_phrases.yield`).
- `plugins/crew/catalogue/generalist-dev.md` — Task 6.
- `plugins/crew/catalogue/security-specialist.md` — Tasks 6 + 7 (token rename + in-domain insistence sentence).
- `plugins/crew/catalogue/test-specialist.md` — Tasks 6 + 7.
- `plugins/crew/catalogue/docs-specialist.md` — Tasks 6 + 7.
- `plugins/crew/catalogue/debugger.md` — Tasks 6 + 7.
- `plugins/crew/catalogue/planner.md` — Task 6.
- `plugins/crew/catalogue/orchestrator.md` — Task 6.
- `plugins/crew/catalogue/retro-analyst.md` — Task 6.
- `plugins/crew/catalogue/hiring-manager.md` — Task 6.
- `plugins/crew/mcp-server/dist/` — Task 9.3 (rebuilt output committed).

### Conventions to pre-empt validator catches

- **Zod 4.x error format.** This codebase is on Zod 4.x. Any vitest assertion against a Zod error message MUST use the v4 output format: `"Invalid option"` (not v3's `"Invalid enum value"`); `{ message: "..." }` form for literal custom errors (not v3's `errorMap` callback). Verified against Story 4-9 / 4-12 pass-2 validator catches.
- **Tmpdir fixtures.** Every test fixture that creates a tmpdir MUST use `await fs.mkdtemp(path.join(os.tmpdir(), "yield-protocol-"))`. Never bare string concatenation; never `${os.tmpdir()}/foo` interpolation; never a fixed path. Verified against Story 4-9 / 4-12 pass-2 validator catches.
- **Cross-AC consistency.** Every error-path clause MUST agree across (i) the AC unpacked sections above, (ii) the Tasks list, (iii) the Implementation strategy, and (iv) the AC6 sub-cases. Specifically: the routing-failure manifest stamp value is `"routing-failure"` (kebab-case, no trailing dot) in every reference; the self-yield manifest stamp value is `"routing-self-yield"` (same convention); the success chat-line format is exactly `yield routed — from <fromRole> to <toRole> on domain "<domain>" — spawning specialist reviewer (clean context)` with the em-dash separator and quoted domain string; the failure chat-line format is exactly `[routing-failure] no hired role matches domain "<domain>" — story <ref> blocked. Clear blocked_by on the manifest and re-run /crew:start after hiring a role with this domain.` with the bracketed prefix; the locked yield phrase is exactly `This sits in <domain>'s domain — handing off.` with em-dash and trailing period. Any inconsistency in these literals is a spec defect — re-read both spec and tests before changing.
- **Test fixture for `tool-registration.test.ts`.** If the tool-count assertion is absent (some Epic-1 stories elided it), Task 5.1 is a no-op for the test bump; just register the tool. Grep for `\.toHaveLength\(27\)` / `\.toBe\(27\)` in the test directory to confirm.
- **The `gray-matter` dependency.** Task 8.3's catalogue-content test parses YAML frontmatter via `gray-matter`. Grep for `gray-matter` in `plugins/crew/mcp-server/package.json` to confirm it's already present; it is used by `parsePersonaFile` and `parseCatalogueFile`. If not present at the top level, import via `from "gray-matter"` (the transitive dep through the existing parsers is sufficient for vitest discovery).

### Status flip clause

The orchestrator owns the `Status:` field at the top of this file (per ship-story SKILL.md). The dev agent MUST NOT edit the `Status:` field or any file under `_bmad-output/implementation-artifacts/` when implementing this story. The Status above is set to `ready-for-dev` by the create-story workflow; the orchestrator's Step 4 commit captures this value as part of the bookkeeping commit that ships in the PR.
