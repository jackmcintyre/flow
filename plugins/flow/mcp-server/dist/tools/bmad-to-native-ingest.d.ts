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
 *   - **Write.** Survivors are written to `.flow/native-stories/<ULID>.md` by
 *     reusing the native render → gate → round-trip-parse → atomic-write
 *     internals DIRECTLY — without the `WrongAdapterError` active-adapter guard.
 *     Writing succeeds with `.flow/config.yaml` still `adapter: bmad` (AC2). You
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
import { z } from "zod";
import type { SourceStory } from "../adapters/adapter.js";
import { type WriteNativeStoryInput } from "./write-native-story.js";
export declare const BmadToNativeIngestInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    sessionUlid: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Transport-shaped input for the registered `bmadToNativeIngest` MCP/CLI tool.
 *
 * The enrich step is LLM-assisted, so it happens in the orchestrating
 * `/flow:ingest` skill (the model), NOT inside this one-shot tool: the skill
 * reads each BMad story (via the read-side seam), drafts the §3 enrichment, and
 * passes the drafts here keyed by source `bmad:<ref>`. The tool then runs the
 * deterministic Tier-0 gate + write over them — the gate is the sole arbiter
 * (AC4). A source ref with no supplied draft (the model judged it un-enrichable)
 * is surfaced in the fix-up report, never silently dropped (AC1).
 */
export declare const BmadToNativeIngestToolInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    sessionUlid: z.ZodOptional<z.ZodString>;
    drafts: z.ZodRecord<z.ZodString, z.ZodObject<{
        title: z.ZodString;
        narrative: z.ZodObject<{
            role: z.ZodString;
            want: z.ZodString;
            so_that: z.ZodString;
        }, z.core.$strip>;
        acceptance_criteria: z.ZodArray<z.ZodObject<{
            text: z.ZodString;
            kind: z.ZodEnum<{
                integration: "integration";
                unit: "unit";
            }>;
            verification: z.ZodObject<{
                type: z.ZodEnum<{
                    artifact: "artifact";
                    vitest: "vitest";
                }>;
                target: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        tasks: z.ZodArray<z.ZodObject<{
            text: z.ZodString;
            ac_refs: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
        cited_sources: z.ZodArray<z.ZodString>;
        implementation_notes: z.ZodOptional<z.ZodString>;
        depends_on: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
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
export type BmadEnricher = (story: SourceStory) => EnrichedDraft | Promise<EnrichedDraft>;
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
 * Run the one-off BMad → native ingest.
 *
 * @param rawInput  validated `BmadToNativeIngestInput`.
 * @param enrich    the prose → §3 enricher. Required — the caller (the
 *                  `/flow:ingest` skill / a test) supplies it. Keeping it a
 *                  parameter (rather than a hidden import) is what makes the
 *                  gate behaviour deterministically testable: a stub enricher
 *                  lets the test prove the Tier-0 gate is the sole arbiter (AC4)
 *                  without a live model call.
 */
export declare function bmadToNativeIngest(rawInput: unknown, enrich: BmadEnricher): Promise<BmadToNativeIngestReport>;
/**
 * Registered MCP/CLI entry point (the one-shot tool transport). The enrich step
 * is LLM-assisted, so it lives in the orchestrating `/flow:ingest` skill, which
 * passes its drafts here keyed by source `bmad:<ref>`. This wrapper turns the
 * `drafts` map into a deterministic enricher and runs the gate + write over the
 * live backlog. The gate — not the supplied draft — decides what is written.
 *
 * A source ref with no supplied draft surfaces in the fix-up report with the
 * `no-enriched-draft-supplied` marker, so the model can see exactly which
 * stories it still owes an enrichment for. Nothing is silently dropped.
 */
export declare function bmadToNativeIngestTool(rawInput: unknown): Promise<BmadToNativeIngestReport>;
