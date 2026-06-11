import type { z } from "zod";
import type { RejectedFile } from "../lib/expected-work-counters.js";

/**
 * Planning-adapter contract.
 *
 * Story 1.1 ships the interface only (with an empty `BmadAdapter`).
 * Story 1.2 extends it with `defaultConfig()` and `adapterConfigSchema`
 * — used by the workspace resolver to synthesise a fresh config and to
 * validate the per-adapter `adapter_config` block from config.yaml.
 * Story 3.1 wires up the registry and `getActiveAdapter()`, and adds
 * the `validateAgainstDiscipline` method signature.
 * Story 3.3 lands the real `BmadAdapter` methods.
 */
export interface PlanningAdapter {
  name: string;
  detect(targetRepo: string): Promise<boolean>;
  listSourceStories(): Promise<SourceStory[]>;
  readSourceStory(ref: string): Promise<SourceStory>;
  resolveSourcePath(ref: string): string;
  watchForChanges?(): AsyncIterable<ChangeEvent>;
  /**
   * Default `adapter_config` block written into `.flow/config.yaml`
   * on first-run auto-detect (Story 1.2 AC2).
   */
  defaultConfig(): Record<string, unknown>;
  /**
   * Zod schema that validates the adapter's `adapter_config` block from
   * a loaded `.flow/config.yaml` (Story 1.2 AC1, AC3).
   */
  adapterConfigSchema: z.ZodTypeAny;
  /**
   * Validate a `SourceStory` against planning-discipline rules and return
   * either the original story (pass) or a structured `DisciplineViolation`
   * (fail).
   *
   * Adapters that have not yet implemented real discipline checks return the
   * input story unchanged. This is the default conformant behaviour. Story 3.5
   * lands the real validator for each adapter.
   *
   * The method is **synchronous** — discipline checks operate on already-
   * normalised `SourceStory` objects in memory; no I/O is required.
   *
   * @see _bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md § Story 3.5
   */
  validateAgainstDiscipline(story: SourceStory): SourceStory | DisciplineViolation;

  /**
   * Return the count of all regular files seen in the adapter's stories
   * directory on the most recent `listSourceStories()` call, plus any files
   * that were seen but could not be used (e.g. because their filename did not
   * match the expected pattern).
   *
   * Optional — adapters that do not implement file-level listing (e.g. BMad)
   * may omit this. `scanSources` uses the result to populate the
   * expected-work counters summary (Story native:01KTSR3E7FE61XB2PN8VJ24289).
   *
   * The result is a snapshot of the most recent listing — it must be called
   * AFTER `listSourceStories()` to reflect the same directory pass.
   */
  getListingStats?(): { filesSeenCount: number; filesRejected: RejectedFile[] };
}

/**
 * A single acceptance criterion.
 *
 * `verification` (Story 10.1) is the structured, machine-readable directive for
 * *how* the AC is checked — `{ type: "vitest" | "artifact", target: "<path>" }`.
 * It is **optional at the type level on purpose**: only the native write/parse
 * path (`parseNativeStory` / `writeNativeStory`) requires it. BMad ACs and any
 * already-persisted manifest leave it `undefined`. (Extracting `verification`
 * from BMad prose markers is the 10.5 ingest seam; checking that `target`
 * resolves to a real file is Tier-0 check T0-6, added in 10.3.)
 */
export type AC = {
  text: string;
  kind: "integration" | "unit";
  verification?: { type: "vitest" | "artifact"; target: string };
};

/**
 * A single planning-discipline rule violation found by
 * `validateAgainstDiscipline`. The union grows additively as new Tier-0 checks
 * land — new string-literal members can be added without breaking existing
 * callers.
 *
 * Story 3.5 codes: `missing-integration-ac`, `implicit-depends-on`,
 * `missing-ship-gate`.
 *
 * Story 5.13 code: `deps-drift-prose-vs-manifest` (scan-only — prose deps and
 * the manifest's `depends_on` set disagree).
 *
 * Story 10.3 — the four remaining Tier-0 checks, gated to native/enriched
 * stories (a BMad story is never failed by them, see
 * `validateStoryAgainstDiscipline`):
 *   - `missing-verification` (T0-2): an AC has no `verification` block.
 *   - `task-ac-ref-unresolved` (T0-1): a task has no `ac_ref`, or one names an
 *     AC the story does not declare.
 *   - `missing-cited-sources` (T0-5): `cited_sources` is empty/absent.
 *   - `unresolvable-cited-source` (T0-5): a cited-source path does not resolve
 *     on disk (a disk check — scan/write paths only).
 *   - `invalid-verification-target` (T0-6): a `verification.target` is not a
 *     well-formed path (e.g. an invented flag like `vitest --grep …`).
 *   - `unresolvable-verification-target` (T0-6): an `artifact:` target does not
 *     resolve on disk (a disk check; `vitest:` targets are shape-checked only —
 *     the build creates that test file, so it need not pre-exist).
 */
export type DisciplineViolationReason = {
  code:
    | "missing-integration-ac"
    | "implicit-depends-on"
    | "missing-ship-gate"
    | "deps-drift-prose-vs-manifest"
    | "missing-verification"
    | "task-ac-ref-unresolved"
    | "missing-cited-sources"
    | "unresolvable-cited-source"
    | "invalid-verification-target"
    | "unresolvable-verification-target";
  field: string;
  detail: string;
};

/**
 * Returned by `validateAgainstDiscipline` when a story fails one or more
 * planning-discipline checks. The discriminant `kind: "discipline-violation"`
 * allows callers to distinguish pass (returned `SourceStory`) from fail
 * (returned `DisciplineViolation`) without a try/catch.
 *
 * Real enforcement logic lands in Story 3.5. Adapters in this story return
 * the input story unchanged (pass-through) as the conformant default.
 */
export type DisciplineViolation = {
  kind: "discipline-violation";
  ref: string;
  violations: DisciplineViolationReason[];
};

/**
 * A single implementation task, each mapped to ≥1 acceptance criterion (Story
 * 10.2 — native `## Tasks` section).
 *
 * `ac_refs` is a non-empty list of AC ids (e.g. `["AC1", "AC3"]`) that the task
 * advances. **Optional at the type level on purpose**: only the native
 * write/parse path requires it. BMad-scanned stories and any already-persisted
 * manifest leave it `undefined`. (Whole-story T0-1 enforcement — required
 * sections present; every task mapped to an AC — is Story 10.3; the
 * intra-story ref-integrity check is enforced at native parse time here.)
 */
export type Task = { text: string; ac_refs: string[] };

/**
 * Structured narrative (Story 10.2 — native `## Narrative` "As a {role}, I want
 * {want}, so that {so_that}." prose parsed into its three parts). **Optional at
 * the type level on purpose**: only the native write/parse path requires it.
 * The raw `narrative` string is always retained alongside it.
 */
export type NarrativeStruct = { role: string; want: string; so_that: string };

export type SourceStory = {
  ref: string;
  title: string;
  narrative: string;
  acceptance_criteria: AC[];
  depends_on: string[];
  implementation_notes?: string;
  /**
   * Structured implementation tasks (Story 10.2). Optional and additive —
   * native-scanned stories carry it; BMad-scanned stories leave it `undefined`
   * (BMad enrichment is the 10.5 ingest's job).
   */
  tasks?: Task[];
  /**
   * Repo-relative source paths cited by the story (Story 10.2). Optional and
   * additive. Presence + shape are checked at native parse time; that each
   * path *resolves on disk* is T0-5, Story 10.3 — not checked here.
   */
  cited_sources?: string[];
  /**
   * Structured narrative parts (Story 10.2). Optional and additive; the raw
   * `narrative` string is always retained.
   */
  narrative_struct?: NarrativeStruct;
  raw_path: string;
  raw_frontmatter: Record<string, unknown>;
  source_hash: string;
};

type ChangeEvent =
  | { kind: "added"; ref: string }
  | { kind: "edited"; ref: string; new_hash: string }
  | { kind: "removed"; ref: string };
