# Story 10.6: Cutover — native-primary, BMad ingest-only

story_shape: substrate
Status: ready-for-dev

## Story

As the operator,
I want to flip the repo's active adapter to `native` (BMad demoted to ingest-only), reconcile the live backlog onto native state, and confirm the board and the drain run on native,
so that the native re-foundation is the live planning substrate — the owned, strict, Tier-0-enforced format — while remaining reversible up to the flip. The adapter-selection, board, and claim paths are already adapter-agnostic, so the cutover is a config flip + a reconciliation + a proof that the live pipeline runs end-to-end on native, not a rewrite.

## Dependencies

- **Depends on 10.5** (ingest must have seeded `.crew/native-stories/` and surfaced any fix-ups) and transitively on 10.1–10.4.
- **Is a prerequisite for** 10.7 (the end-to-end proof runs after cutover, on the native-primary pipeline).
- **Touches** `.crew/config.yaml` (the adapter flip) and is mostly a verification story over existing adapter-agnostic seams (board, claim). No deep code change expected.

## Acceptance Criteria

**AC1 — after cutover, the board renders from native state and the drain claims a blessed native story end-to-end (integration):**

In a temp workspace seeded with native stories: flipping `.crew/config.yaml` to `adapter: native`, scanning, blessing one native story `ready`, and running the claim path results in (a) `/crew:board` (via `getBacklogDashboard` → `readBacklogInventory`) rendering the backlog grouped by epic from native state, with the blessed story shown claimable; and (b) `claimNextStory` claiming that blessed native `ready` story (readiness brake + deps honored), and never claiming an un-blessed one. The BMad authoring/scan path is no longer the live backlog. Observable spine: the live cockpit (board + drain claim) operates on native state after the flip.

vitest: plugins/crew/mcp-server/src/tools/__tests__/claim-next-story.test.ts

**AC2 — adapter resolution returns native on flip; board + claim are ref-agnostic (unit):**

With `adapter: native` in config, `resolveWorkspace`/`getActiveAdapter` bind the native adapter (no detection ambiguity). The board and claim paths render/claim `native:<ULID>` refs identically to how they handled `bmad:<ref>` refs (the ref format is immaterial to state reading). A native-only inventory renders correctly.

vitest: plugins/crew/mcp-server/src/tools/__tests__/read-backlog-inventory.integration.test.ts

**AC3 — the cutover is reversible up to the flip (unit):**

Both adapters remain registered and coexist; native is additive until the flip. Flipping `.crew/config.yaml` back to `adapter: bmad` restores BMad as the active adapter and the BMad backlog as live. The BMad parser remains available as an ingest on-ramp after cutover (it is demoted, not removed).

vitest: plugins/crew/mcp-server/tests/workspace-resolver.test.ts

**AC4 — the cutover is documented and the live backlog reconciled (artifact):**

A short cutover runbook records the steps (ingest → reconcile fix-ups → flip config → scan → bless → verify board+drain) and the reversibility note. Any BMad story not yet migrated (on the 10.5 fix-up list) is explicitly triaged in the runbook before the flip — the flip does not strand un-migrated work.

artifact: plugins/crew/docs/native-cutover-runbook.md

## Definition of Done

- [ ] All four ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green — full suite.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt.
- [ ] `pnpm knip` green.
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean.
- [ ] The actual repo cutover (flipping crew's own `.crew/config.yaml`) is performed only when the operator is satisfied the backlog is reconciled — the runbook gates it; the code change (and tests) can merge ahead of the live flip.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** the cutover — confirm adapter resolution flips cleanly, the board renders from native state, the drain claims native `ready` stories, reversibility holds; plus the cutover runbook and the live-backlog reconciliation.

**Does NOT build:**
- New board/claim logic — those seams are already adapter-agnostic; this story verifies them on native and adds tests where coverage is thin.
- Removal of the BMad adapter/parser — it stays as an ingest on-ramp (ingest-only).
- The ingest itself (10.5) or the end-to-end proof (10.7).

### The seam (do not reinvent)

- **Config flip:** `.crew/config.yaml` `adapter:` field (workspace-config.ts schema). `resolveWorkspace` (workspace-resolver.ts L68-203) + `getActiveAdapter` (registry.ts L82-121) resolve it — no new selection code.
- **Board:** `getBacklogDashboard` → `readBacklogInventory` (render-backlog-dashboard.ts L95-113, read-backlog-inventory.ts) already reads `.crew/state/**` + `.crew/native-stories/` uniformly; verify native rendering, don't rebuild.
- **Claim:** `claimNextStory` → `listClaimableTodos` (claim-next-story.ts L63-126) reads `.crew/state/to-do/` and applies the readiness brake (9.1); ref format is immaterial. Verify a native ready story claims.

### Edge cases worth surfacing in dev/review

- **Pre-mortem (high risk):** assume the flip happened with an incompletely-ingested backlog — in-flight or un-migrated BMad stories are stranded (invisible to the now-native drain). Mitigation (AC4): the runbook gates the flip on reconciling the 10.5 fix-up list. The one assumption that sinks it: that the native-stories dir is a complete superset of the work the team still needs. Verify the reconciliation count before flipping.
- **Detection ambiguity:** with both `.crew/native-stories/` and a BMad backlog present, `detect()` could match both — that is exactly why the cutover uses an explicit `adapter: native` config (Branch A), not detection. Pin this.
- **Reversibility window:** the flip is reversible (config) until downstream native-only work accumulates; the runbook should note the point of practical no-return.
- **The repo's own cutover is an operator act, not a test:** the test proves the mechanism on a fixture; flipping crew's live `.crew/config.yaml` is done deliberately per the runbook.

### Risk + build notes (drain context)

- **Risk tier: high.** Changes the live planning substrate; strand-the-backlog is the failure mode. Reversible up to the flip; the runbook + reconciliation are the controls.
- **Build/verify:** `pnpm --dir plugins/crew/mcp-server test` + `build` + `knip`. Mechanism tests use temp fixtures.
- **Build-order:** after 10.5.

### References

- [Source: _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §6] — the cutover plan (flip adapter, BMad ingest-only, board from native, drain claims native; reversible up to the flip).
- [Source: plugins/crew/mcp-server/src/state/workspace-resolver.ts L68-203, src/adapters/registry.ts L82-121] — adapter resolution the flip drives (no new code).
- [Source: plugins/crew/mcp-server/src/tools/render-backlog-dashboard.ts L95-113, read-backlog-inventory.ts] — the adapter-agnostic board data path.
- [Source: plugins/crew/mcp-server/src/tools/claim-next-story.ts L63-126] — the adapter-agnostic claim path + readiness brake.
- [Source: _bmad-output/implementation-artifacts/10-5-bmad-to-native-ingest-seam.md] — the ingest whose output this cutover reconciles.
