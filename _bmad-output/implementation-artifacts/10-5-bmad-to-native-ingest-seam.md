# Story 10.5: BMad → native ingest seam (one-off, one-way)

story_shape: substrate
Status: ready-for-dev

## Story

As the migration owner cutting the live backlog over to native,
I want a one-off, one-way, reviewed ingest that turns each live BMad story into an enriched native story — inferring the per-AC `verification`, `tasks[]→ac_refs`, and `cited_sources[]` from the BMad prose — gated by the completed Tier-0 validator,
so that the live `bmad:*` backlog can be seeded into `.crew/native-stories/` with anything that can't be enriched to clear Tier-0 **surfaced for human fix-up, never silently dropped**. LLM transforms are lossy — this is fine for a reviewed one-time seed, fatal as a live sync, so the seam is explicitly one-way and never deletes or mutates the source BMad stories.

## Dependencies

- **Depends on 10.1, 10.2, 10.3** — the ingest produces §3-enriched native stories and relies on the completed Tier-0 validator (10.3) to be the deterministic accept/reject filter on each enriched draft.
- **Is a prerequisite for** 10.6 (cutover reconciles the live backlog this ingest seeds).
- **Touches the BMad adapter (read), the native-write internals, and adds a new ingest tool.** Does not modify the discipline validator (consumes 10.3's). Build only after 10.3 has built (and after the Epic 6 drain lands, transitively, since 10.3 does).

## Acceptance Criteria

**AC1 — ingest enriches a BMad story to a Tier-0-clearing native story, or surfaces it for fix-up — never silently drops it (integration):**

Run the ingest over a fixture BMad backlog (via the BMad adapter's `listSourceStories()`). (a) A BMad story whose prose carries the needed signal is enriched to the §3 shape and written to `.crew/native-stories/<ULID>.md`, and the written file parses + clears the Tier-0 validator. (b) A BMad story that cannot be enriched to clear Tier-0 is NOT written — it appears in the ingest's returned fix-up report with the failed Tier-0 check id(s) named, and the source BMad story is untouched. The report's count of (written + needs-fix-up) equals the count of input stories (nothing vanishes). Observable spine: every input story is accounted for — seeded or surfaced, never dropped.

vitest: plugins/crew/mcp-server/src/tools/__tests__/bmad-to-native-ingest.test.ts

**AC2 — ingest writes native files while BMad is still the active adapter (unit):**

The ingest writes to `.crew/native-stories/` by reusing the native render → discipline-gate → round-trip-parse → atomic-write internals **directly**, without requiring the active adapter to be `native` (it does NOT go through `writeNativeStory`'s `WrongAdapterError` guard). You ingest first, cut over second. Writing succeeds with `.crew/config.yaml` still set to `adapter: bmad`.

vitest: plugins/crew/mcp-server/src/tools/__tests__/bmad-to-native-ingest.test.ts

**AC3 — ingest is one-way, non-destructive, and re-run-safe (unit):**

The ingest never mutates or deletes a source BMad story (read-only over the BMad backlog). Re-running it does not duplicate already-ingested stories — it dedupes by source ref via a provenance marker recorded on each emitted native story (e.g. the originating `bmad:<epic>.<story>` ref). A story already ingested is skipped (reported as such), not re-written with a new ULID.

vitest: plugins/crew/mcp-server/src/tools/__tests__/bmad-to-native-ingest.test.ts

**AC4 — the enrichment is LLM-assisted but the accept/reject decision is deterministic (unit):**

The enrich step (BMad prose → §3 fields) is the only non-deterministic part; the gate (Tier-0 validator) is deterministic and is the sole arbiter of whether an enriched draft is written. A draft the LLM produces that fails Tier-0 is rejected by the gate, not written — i.e. enrichment quality cannot smuggle a non-compliant story through. (The transform may be exercised in tests via an injected/stub enricher so the test is deterministic.)

vitest: plugins/crew/mcp-server/src/tools/__tests__/bmad-to-native-ingest.test.ts

## Definition of Done

- [ ] All four ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green — full suite.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt.
- [ ] `pnpm knip` green (the new tool is registered and reachable, not dead).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean.
- [ ] Source BMad backlog is provably untouched by the ingest (read-only assertion in tests).

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** a one-off ingest tool (MCP tool in `src/tools/`, registered in `register.ts`, optionally surfaced as a `crew:ingest` skill) that reads the BMad backlog, enriches each story to the §3 shape, gates on Tier-0, writes the survivors as native stories, and returns a fix-up report for the rest.

**Does NOT build:**
- A live/continuous BMad→native sync — explicitly one-way, one-time (see Story; LLM transforms are lossy).
- The cutover (config flip / reconcile) — Story 10.6.
- Any change to the source BMad stories or the BMad parser's output shape.
- The Tier-0 checks — consumes 10.3's validator as-is.

### The seam (do not reinvent)

- **Read side:** the BMad adapter's `listSourceStories()` / `readSourceStory(ref)` (adapter interface, adapter.ts L14-46) — iterate it directly. Resolve the adapter via `resolveWorkspace`/`getActiveAdapter` (registry.ts L82) — but do NOT require it to be native (it will be `bmad` at ingest time).
- **Write side:** reuse the native-write internals from `write-native-story.ts` — `renderNativeStoryBody`, `validateStoryAgainstDiscipline` (the Tier-0 gate), the `parseNativeStory` round-trip, and `atomicWriteFile` to `.crew/native-stories/<ULID>.md`. Extract a shared internal if needed so ingest and `writeNativeStory` don't diverge — but ingest must skip the `WrongAdapterError` active-adapter guard.
- **Gate:** `validateStoryAgainstDiscipline` (10.3's completed Tier-0) is the accept/reject filter. A `DisciplineViolation` → fix-up report entry (carry the `violations[]` codes), not a write.
- **Provenance:** record the source `bmad:<ref>` on each emitted native story (a dependency-style line or frontmatter) so re-runs dedupe and the migration is auditable.

### Edge cases worth surfacing in dev/review

- **Pre-mortem (high risk):** assume the ingest shipped and the cutover used its output. The disaster is a **silently dropped** or **lossily-enriched-but-passed** story — work vanishes or ships under a hollow spec. Mitigations are ACs: every input is accounted for (AC1), and the deterministic Tier-0 gate — not the LLM — decides what gets written (AC4). The one assumption that sinks it: that Tier-0 is strong enough to catch a plausible-but-hollow enrichment. That is exactly why 10.3 must be complete first.
- **`vitest:` targets in enriched stories won't resolve** (the BMad story's tests may not map cleanly). Per 10.3, `vitest:` targets are shape-checked not existence-checked, so this does not block ingest; `artifact:`/`cited_sources` paths must resolve.
- **Determinism in tests:** inject a stub enricher so the test asserts the gate behavior without a live LLM call.
- **Idempotency:** re-running over a partially-ingested backlog must skip-not-duplicate (AC3) — dedupe on the recorded source ref.

### Risk + build notes (drain context)

- **Risk tier: high.** LLM-assisted, lossy transform feeding the live backlog migration; the silent-drop / hollow-pass failure modes are severe. One-way, reviewed, non-destructive, and deterministically gated — but the pre-mortem is mandatory.
- **Build/verify:** `pnpm --dir plugins/crew/mcp-server test` + `build` + `knip`. Tests deterministic via a stub enricher; no live network in tests.
- **Build-order:** after 10.3 (and thus after the Epic 6 drain).

### References

- [Source: _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §5] — the one-off, one-way, reviewed ingest; surface-for-fix-up-not-silent-drop.
- [Source: plugins/crew/mcp-server/src/adapters/adapter.ts L14-46] — the `PlanningAdapter` interface (`listSourceStories`/`readSourceStory`) the ingest reads.
- [Source: plugins/crew/mcp-server/src/tools/write-native-story.ts L110-180] — the native render → gate → round-trip → atomic-write internals to reuse (skipping the active-adapter guard).
- [Source: plugins/crew/mcp-server/src/adapters/registry.ts L82-121] — adapter resolution (bmad active at ingest time).
- [Source: _bmad-output/implementation-artifacts/10-3-complete-tier-0-discipline-validator.md] — the Tier-0 gate that is the deterministic accept/reject filter.
