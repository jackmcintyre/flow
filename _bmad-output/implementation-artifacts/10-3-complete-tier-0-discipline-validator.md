# Story 10.3: Complete Tier-0 in the discipline validator (fail-closed at write + scan)

story_shape: substrate
Status: ready-for-dev

## Story

As the crew planning cockpit (and the drain that claims only blessed stories),
I want the discipline validator to enforce the four remaining Tier-0 checks against the §3 structured fields — **T0-1** (every task maps to a real AC), **T0-2** (every AC carries a verification block), **T0-5** (cited sources are present and resolve), **T0-6** (every verification target is runnable, not an invented flag) — fail-closed at both `writeNativeStory` and `/crew:scan`,
so that "schema = grading sheet" becomes literally true: a malformed native draft is bounced deterministically before the judge panel spends a cycle on it, and the verification-by-string-match bug class is structurally unrepresentable. With 10.1/10.2 (the fields) this is the heart of the re-foundation — it turns the fields into enforced Tier-0.

## Dependencies

- **Depends on 10.1** (the per-AC `verification` field) and **10.2** (`tasks[].ac_refs`, `cited_sources[]`) — the validator reads those fields, so they must exist first.
- **Is a prerequisite for** 10.5 (ingest surfaces BMad stories that can't clear Tier-0 for human fix-up — that triage uses these checks) and 10.6 (cutover relies on native Tier-0 being complete).
- **⚠️ Touches the discipline validator (`validators/planning-discipline.ts`) and `scan-sources.ts` — the SAME surface the live Epic 6 calibration drain (6.5–6.8) works on. Do NOT build this story while that drain is live; author now, build after Track A lands.** (10.1/10.2 are build-safe; 10.3 is the one that must wait.)

## Acceptance Criteria

**AC1 — scan blocks a Tier-0-violating native story and never blocks a BMad story for the new checks (integration):**

Drive `/crew:scan` (`scanSources`) on a temp native workspace. (a) A native story that violates any new check — an AC with no `verification`, a task whose `ac_refs` is empty, an empty `cited_sources`, a `cited_sources` path that doesn't resolve on disk, or an `artifact:` verification target that doesn't resolve — is written to `blocked/` with `blocked_by: "planning-discipline"` and a `discipline_violations` array carrying the specific new code(s); it is NOT written to `to-do/`. (b) A fully-compliant native story scans to `to-do/`. (c) **Non-regression:** a BMad-shaped source story that lacks the enriched fields scans exactly as before — the new checks do NOT block it (they are gated to native/enriched stories until ingest+cutover). This is the spine: Tier-0 violations are caught fail-closed at scan, and BMad scanning is untouched.

vitest: plugins/crew/mcp-server/tests/scan-sources.test.ts

**AC2 — the pure validator gains T0-1 and T0-2, gated to enriched stories (unit):**

`validateStoryAgainstDiscipline` (pure, no I/O) gains: **T0-2** — every AC has a `verification` block (else a `missing-verification` violation naming the AC); **T0-1** — every task has ≥1 `ac_ref` and each resolves to a real AC id in the story (else `task-ac-ref-unresolved`). Both apply only to native/enriched stories (`ref` starts `native:`, or an explicit enriched flag); a BMad `SourceStory` (or any story whose enriched fields are absent) is NOT failed by them. The `DisciplineViolationReason["code"]` union is widened with the new codes. Multiple violations accumulate in the existing `violations[]` array.

vitest: plugins/crew/mcp-server/src/validators/__tests__/planning-discipline.test.ts

**AC3 — a resolvability pass enforces T0-5 and T0-6 against disk at the I/O boundary (unit):**

A resolvability check (run where `targetRepoRoot` + fs are available — the scan and write paths, reusing the existing `statOrNull` + `path.resolve(targetRepoRoot, …)` seam) emits: **T0-5** — `cited_sources` non-empty (`missing-cited-sources`) and each path resolves on disk (`unresolvable-cited-source`); **T0-6** — every `verification.target` is well-formed (reject invented flags / non-path strings such as `vitest --grep …` → `invalid-verification-target`), and an `artifact:` target resolves on disk (`unresolvable-verification-target`). A `vitest:` target is shape-checked but NOT required to pre-exist (the build creates the test — see Edge cases). Violations merge into the same `DisciplineViolation.violations[]`.

vitest: plugins/crew/mcp-server/tests/scan-sources.test.ts

**AC4 — write is fail-closed on the writable-time checks (unit):**

`writeNativeStory` rejects (throws `DisciplineViolationError`, nothing written) a native story failing the writable-time checks: T0-1, T0-2, T0-5 (cited sources present and resolving — they are files the author read, so they exist at write), and the pure part of T0-6 (reject invented flags). New-test-file `vitest:` targets are NOT required to resolve at write. The error carries the new codes.

vitest: plugins/crew/mcp-server/src/tools/__tests__/write-native-story.test.ts

## Definition of Done

- [ ] All four ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green — the **full** suite (validator + scan + write are load-bearing; nothing regresses, especially BMad scan).
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt.
- [ ] `pnpm knip` green.
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean.
- [ ] **Non-regression proven by test:** an existing BMad scan fixture still scans to `to-do/` (not blocked) under the new checks — gating to native/enriched stories holds.
- [ ] **Build-order honored:** merged only after the Epic 6 calibration drain (6.5–6.8) has landed (shared validator/standards surface).

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** the four remaining Tier-0 checks (T0-1, T0-2, T0-5, T0-6), split pure (validator) vs disk (resolvability pass at the I/O boundary), gated to native/enriched stories, fail-closed at write + scan.

**Does NOT build:**
- The §3 fields themselves (10.1/10.2) — this story only *reads and enforces* them.
- BMad enrichment / ingest (10.5) — this story leaves BMad scanning untouched.
- Any config-driven rules engine — the existing checks are hardcoded TS; add the new ones the same way (see below). Do NOT introduce a `discipline-rules.yaml` here.

### The two top risks (Considered) — pin these or the story breaks something

1. **BMad regression.** The validator runs on every scanned story. If T0-2/T0-1/T0-5/T0-6 fire unconditionally, every BMad story (no `verification`/`tasks`/`cited_sources` yet) is blocked — a live-backlog outage. **Mitigation (AC1c + AC2):** gate the new checks to native/enriched stories (`ref.startsWith("native:")`, or an explicit enriched signal) until ingest (10.5) + cutover (10.6). A BMad story is never failed by the new checks.
2. **Chicken-and-egg on T0-6 `vitest:` targets.** A `vitest:` target is a test file the *build* creates — it does not exist at author or scan time. Requiring it to resolve would make every new-test story un-writable/un-scannable. **Mitigation (AC3/AC4):** T0-6 = (a) reject invented flags / non-path strings (pure, always on) + (b) require on-disk resolution only for `artifact:` targets (existing contracts) and `cited_sources` (files the author read). `vitest:` targets are shape-checked, not existence-checked. "Reject invented flags" is the part of T0-6 that kills the `vitest --grep` anti-pattern the rubric names.

### Files touched

**UPDATE:**
- `plugins/crew/mcp-server/src/adapters/adapter.ts` (~L57-76) — widen `DisciplineViolationReason["code"]` with: `missing-verification`, `task-ac-ref-unresolved`, `missing-cited-sources`, `unresolvable-cited-source`, `invalid-verification-target`, `unresolvable-verification-target`.
- `plugins/crew/mcp-server/src/validators/planning-discipline.ts` (~L141) — add the PURE T0-1 and T0-2 checks to `validateStoryAgainstDiscipline`, gated to enriched/native stories; mirror the existing check structure (return additional `DisciplineViolationReason`s into the `violations[]` array). Keep this function pure (no I/O).
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` (~L524, +L433) — after the pure validator, run the resolvability pass (T0-5/T0-6 disk checks) using the existing `statOrNull` (L117-123) + `path.resolve(targetRepoRoot, …)`; merge resolvability violations into the blocked manifest's `discipline_violations`.
- `plugins/crew/mcp-server/src/tools/write-native-story.ts` (~L146-152) — extend the write-time gate to run the pure checks + the writable-time resolvability (cited sources + invented-flag rejection); keep the existing `DisciplineViolationError` throw. Do NOT existence-check `vitest:` targets at write.

**NEW (if a clean home is wanted):**
- A small resolvability helper (e.g. `resolveDisciplinePaths(story, targetRepoRoot)`) co-located with scan or the validator, so write + scan share one implementation. Reuse `statOrNull`; do not reinvent fs-exists.

### Existing seams to wire into (do not reinvent)

- **Pure validator:** `validateStoryAgainstDiscipline(story, opts?)` (planning-discipline.ts L141) returns `SourceStory | DisciplineViolation`; the `kind: "discipline-violation"` discriminant is how callers branch. Add new checks here for the pure ones; keep returning the same shape.
- **Violation type + write error:** `DisciplineViolation` / `DisciplineViolationReason` (adapter.ts L57-76); `DisciplineViolationError` (errors.ts ~L1777). Reuse — only widen the code union.
- **Scan fail-closed path:** scan already writes violators to `blocked/` with `blocked_by: "planning-discipline"` + `discipline_violations` (scan-sources.ts ~L524, 546-582). New violations flow through the same path — no new status, no new sink.
- **Disk checks:** `statOrNull` (scan-sources.ts L117-123) + `repoRelativePath` (L130-137). Construct absolute paths with `path.resolve(targetRepoRoot, citedOrTargetPath)`.
- **Existing tests:** pure validator tests use the `makeStory()` inline-fixture helper (planning-discipline.test.ts L21-34); scan integration uses the `scan-sources-discipline-fixture` disk fixture (scan-sources.test.ts L286-341). Extend both.

### Edge cases worth surfacing in dev/review

- **Pre-mortem (medium/high risk — Considered):** assume this shipped and broke the live backlog. The cause would be (1) the new checks not gated to native, blocking BMad scans, or (2) requiring `vitest:` targets to exist, blocking every new-test story. Both are pinned by ACs (1c, 3, 4). The one assumption that sinks the story if wrong: *that gating by `native:` ref is sufficient to protect BMad scanning pre-cutover* — confirm there is no path where a BMad story is presented to the validator as native.
- **`artifact:` vs `vitest:` resolvability asymmetry** is deliberate: artifacts are existing contracts (must resolve); vitest targets are build outputs (shape only). Document it in the violation `detail` so a reviewer doesn't "fix" it into symmetry.
- **Multiple violations** must all be reported (the array accumulates) — don't short-circuit on the first; the author needs the full list to fix in one pass.
- **Idempotency:** re-scanning a blocked story after the source is fixed must move it out of `blocked/` (the existing remediation branch at scan-sources.ts L433 handles this — confirm the new checks participate).

### Risk + build notes (drain context)

- **Risk tier: high.** Touches the validator + scan + write enforcement paths simultaneously, on the shared standards surface, with a live-backlog-outage failure mode (BMad regression). The pre-mortem above is mandatory; the full suite + the BMad non-regression test are the ship gate.
- **Build/verify:** `pnpm --dir plugins/crew/mcp-server test` + `build`, both green, plus `pnpm knip`. Deterministic; the disk checks use a temp fixture, no network.
- **⚠️ Build-order:** merge only after the Epic 6 calibration drain (6.5–6.8) lands — this is the one Epic 10 story that collides with Track A's surface.

### References

- [Source: _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §4] — Tier-0 completion in code, fail-closed at write + scan; the four checks to add.
- [Source: _bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md §2] — T0-1/T0-2/T0-5/T0-6 definitions; the `vitest --grep` invented-flag anti-pattern.
- [Source: plugins/crew/mcp-server/src/validators/planning-discipline.ts L141-249] — the pure validator + the 3 existing checks to mirror.
- [Source: plugins/crew/mcp-server/src/adapters/adapter.ts L57-76] — `DisciplineViolation`/`DisciplineViolationReason` to widen.
- [Source: plugins/crew/mcp-server/src/tools/scan-sources.ts L117-123 statOrNull, L130-137 repoRelativePath, L524 + L546-582 blocked-manifest path] — scan enforcement + disk-check seams.
- [Source: plugins/crew/mcp-server/src/tools/write-native-story.ts L146-152] — write-time gate to extend.
- [Source: _bmad-output/implementation-artifacts/10-1-enrich-native-ac-verification-block.md, 10-2-native-tasks-ac-refs-cited-sources-and-narrative.md] — the fields this story enforces; the same gating/additive discipline.
