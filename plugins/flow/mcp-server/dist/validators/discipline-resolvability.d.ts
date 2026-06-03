/**
 * Disk-side Tier-0 discipline checks (Story 10.3 — T0-5 and the disk part of
 * T0-6). These run where `targetRepoRoot` + an fs are available — the scan
 * (`scanSources`) and write (`writeNativeStory`) paths — so they live OUTSIDE
 * the pure `validateStoryAgainstDiscipline` validator (which is I/O-free by
 * contract).
 *
 * Both callers share this one implementation so the write-time gate and the
 * scan-time gate enforce identically. Violations returned here merge into the
 * same `DisciplineViolation.violations[]` array the pure validator produces.
 *
 * Checks (native/enriched stories only — `isEnrichedStory`):
 *   - **T0-5** — `cited_sources` is non-empty (`missing-cited-sources`) and each
 *     path resolves on disk (`unresolvable-cited-source`). Cited sources are
 *     files the author read, so they exist at author/scan time.
 *   - **T0-6** — every `verification.target` is well-formed (reject invented
 *     flags / non-path strings such as `vitest --grep …` →
 *     `invalid-verification-target`), and an `artifact:` target resolves on disk
 *     (`unresolvable-verification-target`). A `vitest:` target is shape-checked
 *     but NOT required to pre-exist: it is the test file the *build* creates, so
 *     requiring it would make every new-test story un-writable/un-scannable
 *     (the chicken-and-egg the story's pre-mortem pins). The `artifact:` vs
 *     `vitest:` resolvability asymmetry is DELIBERATE — artifacts are existing
 *     contracts (must resolve); vitest targets are build outputs (shape only).
 *
 * @see _bmad-output/implementation-artifacts/10-3-complete-tier-0-discipline-validator.md
 */
import type { DisciplineViolationReason, SourceStory } from "../adapters/adapter.js";
/**
 * Run the disk-side Tier-0 checks (T0-5 + the disk part of T0-6) against a
 * native/enriched story. Returns the accumulated violations — an empty array
 * means the story passes the disk checks. A non-enriched story (BMad) returns
 * `[]` unconditionally: the new checks are gated to native/enriched stories
 * until ingest (10.5) + cutover (10.6).
 *
 * Multiple violations accumulate — the function does NOT short-circuit on the
 * first failure, so the author/operator sees the full list to fix in one pass.
 *
 * @param story          The story to check (already-parsed `SourceStory`).
 * @param targetRepoRoot The repo root against which repo-relative paths resolve.
 */
export declare function resolveDisciplinePaths(story: SourceStory, targetRepoRoot: string): Promise<DisciplineViolationReason[]>;
