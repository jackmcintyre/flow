/**
 * BMad → native ingest seam (Story 10.5) — a one-off, one-way, reviewed ingest
 * that turns each live BMad story into an enriched native story.
 *
 * The shape of the contract (see the story spec):
 *
 *   - **Read side.** Resolve the active adapter (BMad at ingest time) and
 *     iterate `listSourceStories()`. The ingest is READ-ONLY over the BMad
 *     backlog — it never mutates or deletes a source story.
 *   - **Enrich.** A BMad `SourceStory` has prose ACs but no §3 structure
 *     (no per-AC `verification`, no `tasks[]→ac_refs`, no `cited_sources[]`,
 *     no structured narrative). The `enrich` step infers those fields from the
 *     BMad prose. This is the ONLY non-deterministic part (LLM-assisted in
 *     production; an injected stub in tests).
 *   - **Gate.** The completed Tier-0 validator (Story 10.3) is the deterministic
 *     SOLE arbiter of whether an enriched draft is written. It runs INSIDE the
 *     shared native-write internal (`renderGateWriteNativeStory`): a candidate
 *     that fails Tier-0 throws `DisciplineViolationError` and NOTHING is written.
 *     Enrichment quality cannot smuggle a non-compliant story through (AC4).
 *   - **Write.** Survivors are written to `.crew/native-stories/<ULID>.md` by
 *     reusing the native render → gate → round-trip-parse → atomic-write
 *     internals DIRECTLY — without the `WrongAdapterError` active-adapter guard.
 *     Writing succeeds with `.crew/config.yaml` still `adapter: bmad` (AC2). You
 *     ingest first, cut over second (the cutover is Story 10.6).
 *   - **Account for everything.** The returned report's `written` +
 *     `needs_fix_up` + `skipped` count equals the input count — nothing is ever
 *     silently dropped (AC1, the observable spine). A story that cannot be
 *     enriched to clear Tier-0 is SURFACED in the fix-up report with the failed
 *     check id(s), never dropped.
 *   - **Provenance + idempotency.** Each emitted native story records its
 *     originating `bmad:<epic>.<story>` ref (as a `## Cited Sources` entry — the
 *     BMad source file the ingest read). Re-running dedupes by that recorded
 *     ref: an already-ingested story is reported `skipped`, NOT re-written with
 *     a fresh ULID (AC3).
 *
 * Does NOT build: a live/continuous sync (this is explicitly one-way, one-time;
 * LLM transforms are lossy), the cutover (Story 10.6), any change to the BMad
 * source stories or the Tier-0 checks (consumes 10.3's validator as-is).
 *
 * @see _bmad-output/implementation-artifacts/10-5-bmad-to-native-ingest-seam.md
 * @see _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §5
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { SourceStory } from "../adapters/adapter.js";
import { DisciplineViolationError } from "../errors.js";
import { parseNativeStory } from "../adapters/native/parse-native-story.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
import {
  renderGateWriteNativeStory,
  type WriteNativeStoryInput,
} from "./write-native-story.js";

export const BmadToNativeIngestInputSchema = z.object({
  targetRepoRoot: z.string().min(1),
  /**
   * Session id for the per-story `draft.authored` telemetry envelope. Optional —
   * `/crew:ingest` passes its orchestration session ULID when available.
   */
  sessionUlid: z.string().min(1).optional(),
});

/**
 * Zod schema for a single enriched draft supplied over the tool transport. The
 * `/crew:ingest` skill (the LLM enricher) reads each BMad story and produces one
 * of these per source ref; the tool then GATES + WRITES deterministically. The
 * gate — not the supplied draft — decides what lands (AC4), so this schema is
 * the loosest shape that `WriteNativeStoryInput` accepts; Tier-0 does the rest.
 */
const EnrichedDraftSchema = z.object({
  title: z.string().min(1),
  narrative: z.object({
    role: z.string().min(1),
    want: z.string().min(1),
    so_that: z.string().min(1),
  }),
  acceptance_criteria: z
    .array(
      z.object({
        text: z.string().min(1),
        kind: z.enum(["integration", "unit"]),
        verification: z.object({
          type: z.enum(["vitest", "artifact"]),
          target: z.string().min(1),
        }),
      }),
    )
    .min(1),
  tasks: z
    .array(z.object({ text: z.string().min(1), ac_refs: z.array(z.string().min(1)).min(1) }))
    .min(1),
  cited_sources: z.array(z.string().min(1)),
  implementation_notes: z.string().optional(),
  depends_on: z.array(z.string()),
});

/**
 * Transport-shaped input for the registered `bmadToNativeIngest` MCP/CLI tool.
 *
 * The enrich step is LLM-assisted, so it happens in the orchestrating
 * `/crew:ingest` skill (the model), NOT inside this one-shot tool: the skill
 * reads each BMad story (via the read-side seam), drafts the §3 enrichment, and
 * passes the drafts here keyed by source `bmad:<ref>`. The tool then runs the
 * deterministic Tier-0 gate + write over them — the gate is the sole arbiter
 * (AC4). A source ref with no supplied draft (the model judged it un-enrichable)
 * is surfaced in the fix-up report, never silently dropped (AC1).
 */
export const BmadToNativeIngestToolInputSchema = BmadToNativeIngestInputSchema.extend({
  drafts: z.record(z.string(), EnrichedDraftSchema),
});

/**
 * The enrich step: BMad prose → the §3 native draft fields. This is the only
 * non-deterministic part of the ingest. In production an LLM-backed enricher
 * implements it; tests inject a deterministic stub so the gate behaviour is
 * asserted without a live model call (AC4).
 *
 * The enricher returns the parts of `WriteNativeStoryInput` it infers from the
 * prose. The ingest fills `targetRepoRoot`/`sessionUlid` and ALWAYS appends the
 * provenance citation, so an enricher cannot accidentally drop it.
 */
export type EnrichedDraft = {
  title: string;
  narrative: WriteNativeStoryInput["narrative"];
  acceptance_criteria: WriteNativeStoryInput["acceptance_criteria"];
  tasks: WriteNativeStoryInput["tasks"];
  cited_sources: string[];
  implementation_notes?: string;
  depends_on: string[];
};

export type BmadEnricher = (
  story: SourceStory,
) => EnrichedDraft | Promise<EnrichedDraft>;

/** A single emitted (written) native story. */
export type IngestWritten = {
  source_ref: string;
  native_ref: string;
  path: string;
};

/** A BMad story that could not be enriched to clear Tier-0 — surfaced, not dropped. */
export type IngestNeedsFixUp = {
  source_ref: string;
  /** Tier-0 violation codes that blocked the write (e.g. `missing-cited-sources`). */
  failed_checks: string[];
  detail: string;
};

/** A BMad story already ingested on a prior run — deduped by provenance, not re-written. */
export type IngestSkipped = {
  source_ref: string;
  /** The existing native story that already carries this source ref as provenance. */
  existing_native_path: string;
};

export interface BmadToNativeIngestReport {
  /** Source adapter the ingest read from (always `bmad` in v1). */
  source_adapter: string;
  /** Count of input BMad stories the ingest iterated. */
  input_count: number;
  written: IngestWritten[];
  needs_fix_up: IngestNeedsFixUp[];
  skipped: IngestSkipped[];
}

/**
 * The provenance marker line emitted into each ingested native story's
 * `## Cited Sources`. The originating BMad source file is, literally, a source
 * the (enriched) native story is grounded in — so recording it as a cited
 * source both satisfies the Tier-0 cited-sources requirement and gives the
 * re-run dedupe + migration audit a single, parse-recoverable anchor.
 *
 * Returns the repo-relative path to the BMad story file for the given ref, used
 * verbatim as a `## Cited Sources` bullet.
 */
function provenanceCitation(bmadSourcePath: string, targetRepoRoot: string): string {
  return path.relative(targetRepoRoot, bmadSourcePath);
}

/**
 * Build the set of source refs already ingested, by scanning the existing
 * `.crew/native-stories/` for the provenance citation each ingested story
 * carries. A native story counts as "already ingested from `bmad:<ref>`" when
 * its `## Cited Sources` includes the BMad source file path for that ref.
 *
 * Read-only. Returns a map source-bmad-path → existing native story path so the
 * skip report can name the file that already covers a source ref.
 */
async function indexAlreadyIngested(
  storiesDir: string,
): Promise<Map<string, string>> {
  const byCitedPath = new Map<string, string>();
  let entries: string[];
  try {
    entries = (await fs.readdir(storiesDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return byCitedPath; // No native-stories dir yet → nothing ingested.
  }
  for (const name of entries) {
    const abs = path.join(storiesDir, name);
    let parsed: SourceStory;
    try {
      parsed = parseNativeStory(abs, await fs.readFile(abs, "utf8"));
    } catch {
      // A malformed/unparseable native story is not the ingest's concern here —
      // skip it for dedupe purposes (it will surface elsewhere).
      continue;
    }
    for (const cited of parsed.cited_sources ?? []) {
      // First writer wins — keep the earliest match so the skip report is stable.
      if (!byCitedPath.has(cited)) byCitedPath.set(cited, abs);
    }
  }
  return byCitedPath;
}

/**
 * Run the one-off BMad → native ingest.
 *
 * @param rawInput  validated `BmadToNativeIngestInput`.
 * @param enrich    the prose → §3 enricher. Required — the caller (the
 *                  `/crew:ingest` skill / a test) supplies it. Keeping it a
 *                  parameter (rather than a hidden import) is what makes the
 *                  gate behaviour deterministically testable: a stub enricher
 *                  lets the test prove the Tier-0 gate is the sole arbiter (AC4)
 *                  without a live model call.
 */
export async function bmadToNativeIngest(
  rawInput: unknown,
  enrich: BmadEnricher,
): Promise<BmadToNativeIngestReport> {
  const input = BmadToNativeIngestInputSchema.parse(rawInput);
  const targetRepoRoot = path.resolve(input.targetRepoRoot);

  // Read side — resolve the active adapter and list its source stories. The
  // ingest does NOT require `native`: at ingest time the active adapter is
  // `bmad` (you ingest first, cut over second). We read whatever adapter is
  // active and iterate its backlog.
  const workspace = await resolveWorkspace({ targetRepoRoot });
  const sourceStories = await workspace.activeAdapter.listSourceStories();

  const storiesDir = path.join(targetRepoRoot, ".crew", "native-stories");
  // Index what is already ingested so a re-run dedupes (AC3). Built once, up
  // front — newly-written stories within THIS run also extend the index so a
  // backlog that (pathologically) lists the same source twice does not
  // double-write.
  const alreadyIngested = await indexAlreadyIngested(storiesDir);

  const written: IngestWritten[] = [];
  const needs_fix_up: IngestNeedsFixUp[] = [];
  const skipped: IngestSkipped[] = [];

  for (const story of sourceStories) {
    const provenance = provenanceCitation(story.raw_path, targetRepoRoot);

    // Idempotency / dedupe — already ingested? Skip, do not re-write (AC3).
    const existing = alreadyIngested.get(provenance);
    if (existing) {
      skipped.push({ source_ref: story.ref, existing_native_path: existing });
      continue;
    }

    // Enrich + gate + write. The enrich step is the only non-deterministic
    // part; it runs INSIDE the try so a failed enrichment (e.g. the transport
    // enricher signalling no draft was supplied for this ref) is surfaced for
    // fix-up rather than aborting the whole ingest — every input is accounted
    // for (AC1). The Tier-0 gate (inside the shared internal) is the sole
    // arbiter of what gets written: a DisciplineViolationError → fix-up report
    // entry carrying the failed check id(s), and NOTHING is written. The
    // active-adapter guard is deliberately skipped (AC2) — this is the only
    // place ingest diverges from writeNativeStory.
    try {
      // Always append the provenance citation so re-runs dedupe and the
      // migration is auditable; de-dup it in case the enricher already included it.
      const draft = await enrich(story);
      const cited_sources = draft.cited_sources.includes(provenance)
        ? draft.cited_sources
        : [...draft.cited_sources, provenance];

      const candidate: WriteNativeStoryInput = {
        targetRepoRoot,
        title: draft.title,
        narrative: draft.narrative,
        acceptance_criteria: draft.acceptance_criteria,
        tasks: draft.tasks,
        cited_sources,
        implementation_notes: draft.implementation_notes,
        depends_on: draft.depends_on,
        sessionUlid: input.sessionUlid,
      };

      const result = await renderGateWriteNativeStory(candidate, targetRepoRoot, "ingest");
      written.push({
        source_ref: story.ref,
        native_ref: result.ref,
        path: result.path,
      });
      // Extend the in-run index so the same source can never be written twice.
      alreadyIngested.set(provenance, result.path);
    } catch (err) {
      if (err instanceof DisciplineViolationError) {
        needs_fix_up.push({
          source_ref: story.ref,
          failed_checks: err.violations.map((v) => v.code),
          detail: err.message,
        });
        continue;
      }
      // Any non-Tier-0 failure (e.g. a malformed enrichment the round-trip
      // parser rejects) is also surfaced for fix-up — never silently dropped.
      needs_fix_up.push({
        source_ref: story.ref,
        failed_checks: ["ingest-error"],
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    source_adapter: workspace.activeAdapterName,
    input_count: sourceStories.length,
    written,
    needs_fix_up,
    skipped,
  };
}

/**
 * Sentinel thrown by the transport enricher when the orchestrating skill
 * supplied no draft for a source ref (it judged the story un-enrichable). The
 * ingest loop catches it like any other failure and routes the story into the
 * fix-up report — surfaced, never dropped (AC1).
 */
const NO_DRAFT_SUPPLIED = "no-enriched-draft-supplied";

/**
 * Registered MCP/CLI entry point (the one-shot tool transport). The enrich step
 * is LLM-assisted, so it lives in the orchestrating `/crew:ingest` skill, which
 * passes its drafts here keyed by source `bmad:<ref>`. This wrapper turns the
 * `drafts` map into a deterministic enricher and runs the gate + write over the
 * live backlog. The gate — not the supplied draft — decides what is written.
 *
 * A source ref with no supplied draft surfaces in the fix-up report with the
 * `no-enriched-draft-supplied` marker, so the model can see exactly which
 * stories it still owes an enrichment for. Nothing is silently dropped.
 */
export async function bmadToNativeIngestTool(
  rawInput: unknown,
): Promise<BmadToNativeIngestReport> {
  const input = BmadToNativeIngestToolInputSchema.parse(rawInput);
  const enrich: BmadEnricher = (story) => {
    const draft = input.drafts[story.ref];
    if (!draft) {
      // No draft for this source ref → surface it for fix-up (caught below).
      throw new Error(
        `${NO_DRAFT_SUPPLIED}: no enriched draft was supplied for ${story.ref}. ` +
          `The /crew:ingest skill must draft a §3 enrichment for every BMad story ` +
          `it intends to seed, or leave the story for human fix-up.`,
      );
    }
    return draft;
  };
  return bmadToNativeIngest(
    { targetRepoRoot: input.targetRepoRoot, sessionUlid: input.sessionUlid },
    enrich,
  );
}
