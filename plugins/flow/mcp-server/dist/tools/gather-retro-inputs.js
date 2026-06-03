/**
 * `gatherRetroInputs` MCP tool — Story 6.2 AC3 (FR56).
 *
 * Assembles the deterministic input bundle that the `/flow:retro` skill
 * hands to the retro-analyst subagent. This is the **input-gathering
 * seam**: a pure, side-effect-free read across the cycle's done manifests,
 * telemetry, prior proposals, and (when present) the rule registry.
 *
 * The bundle is the deterministic spine of the retro run. The analyst is
 * an LLM with read-only affordances (Story 6.2 AC5 negative-capability
 * surface); this tool guarantees that the *facts* it reasons over are
 * tool-gathered and schema-validated, not scraped from prose. See project
 * memory `feedback_default_to_deterministic_seams`.
 *
 * Returned shape `{ doneManifests, telemetrySummary, priorProposals, ruleRegistry }`:
 *
 *   - `doneManifests`: every `.yaml` under `<targetRepoRoot>/.flow/state/done/`,
 *     in deterministic alphabetical filename order, each parsed via
 *     `parseExecutionManifest`. A malformed manifest propagates as
 *     `MalformedExecutionManifestError` (NOT swallowed) — a corrupt done/
 *     manifest is a hard stop, not a skippable line. `.snapshot.yaml`
 *     sidecars (Story 5.29) are excluded. When a work cycle is open (the
 *     `.flow/cycle-state.json` file is present), this is scoped to manifests
 *     completed at or after the cycle's `opened_at` instant — a manifest's
 *     completion time is its file mtime (the done/ manifest is written by
 *     `completeStory` at completion). Story native:01KT484NY4HCBPBTT6VEY1Q0CS.
 *
 *   - `telemetrySummary`: every event from `<targetRepoRoot>/.flow/telemetry/*.jsonl`
 *     in the **current cycle window**, parsed line-by-line through
 *     `TelemetryEventSchema`. When a cycle is open, events are scoped to those
 *     whose `ts` is at or after the cycle's `opened_at`; when no cycle has ever
 *     been opened, every `.jsonl` event present at gather time is included
 *     (the existing baseline). Malformed lines (bad JSON or failed Zod) are
 *     skipped, COUNTED, and the count is returned as `skipped_count` so the
 *     analyst can flag corrupt logs without the run crashing. Files are read in
 *     alphabetical order; events preserve in-file line order. Story
 *     native:01KT484NY4HCBPBTT6VEY1Q0CS (the cycle-boundary work deferred by
 *     Story 6.12).
 *
 *   - `priorProposals`: `{ path, iso_timestamp }` for every existing
 *     `<targetRepoRoot>/.flow/retro-proposals/*.md`, sorted by ISO timestamp
 *     ascending. File contents are NOT loaded — the analyst reads them via
 *     the `Read` tool if needed (keeps the bundle bounded). `iso_timestamp`
 *     is derived from the filename stem (the writer keys files by ISO
 *     timestamp — Story 6.3).
 *
 *   - `ruleRegistry`: parsed contents of `<targetRepoRoot>/docs/discipline-rules.yaml`
 *     via the comment-preserving `yaml` package, or `null` when the file is
 *     absent. Absence is NOT an error (6a phase: the registry doesn't exist
 *     yet; Story 6.5 introduces it). The analyst proceeds with
 *     `ruleRegistry: null`.
 *
 * **No writes. No network. No clock dependency.** Pure parameterised IO.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { readCycleState } from "../schemas/cycle-state.js";
import { parseExecutionManifest, } from "../schemas/execution-manifest.js";
import { TelemetryEventSchema, } from "../schemas/telemetry-events.js";
import { parseRuleRegistry } from "../schemas/discipline-rules.js";
import { computeFailureClassFireCounts, } from "../lib/failure-class-fire-counts.js";
import { computeSkillEffectiveness, } from "./compute-skill-effectiveness.js";
/** Month-bucket filename pattern matching the Story 1.5 logger contract. */
const TELEMETRY_FILE_REGEX = /\.jsonl$/;
/**
 * Gather the retro input bundle. See module JSDoc for full behaviour.
 *
 * @throws {MalformedExecutionManifestError} When a `done/` manifest fails
 *   schema validation. A corrupt done/ manifest is a hard stop — unlike
 *   telemetry lines, it is not skippable.
 */
export async function gatherRetroInputs(opts) {
    const { targetRepoRoot, fireCountConfig } = opts;
    // Resolve the cycle window. An explicit `cycleState` (the test seam) wins;
    // otherwise read the on-disk cycle-state file. `null` ⇒ no boundary ⇒
    // full-history baseline (Story native:01KT484NY4HCBPBTT6VEY1Q0CS / AC4). The
    // boundary instant is the cycle's `opened_at`, parsed once into epoch millis.
    const cycleState = opts.cycleState !== undefined
        ? opts.cycleState
        : await readCycleState(targetRepoRoot);
    const windowStartMs = cycleState ? Date.parse(cycleState.opened_at) : null;
    const doneManifests = await gatherDoneManifests(targetRepoRoot, windowStartMs);
    const telemetrySummary = await gatherTelemetry(targetRepoRoot, windowStartMs);
    const priorProposals = await gatherPriorProposals(targetRepoRoot);
    const ruleRegistry = await gatherRuleRegistry(targetRepoRoot);
    // Compute fire-count signal for the analyst. Only available when the registry
    // exists; null in the 6a phase.
    let fireCountSignal = null;
    if (ruleRegistry !== null) {
        const registryTyped = ruleRegistry;
        const result = computeFailureClassFireCounts({ doneManifests, telemetrySummary, ruleRegistry: registryTyped }, fireCountConfig);
        fireCountSignal = {
            promotionCandidates: result.promotionCandidates,
            retirementCandidates: result.retirementCandidates,
        };
    }
    // Compute recurring friction signal from telemetry events.
    // Only friction that recurs at threshold (count >= 2) is surfaced.
    const recurringFriction = computeRecurringFriction(telemetrySummary.events);
    // Compute per-skill effectiveness signal (Story 6.8). The helper reads the
    // cycle's skill.invoke + reviewer.verdict telemetry and joins each invocation
    // to a downstream READY FOR MERGE verdict. It always returns a safe shape
    // (an empty per_skill map when no telemetry exists), so no null-guard is
    // needed and the retro never fails on an absent signal.
    const skillEffectiveness = await computeSkillEffectiveness({ targetRepoRoot });
    return { doneManifests, telemetrySummary, priorProposals, ruleRegistry, fireCountSignal, recurringFriction, skillEffectiveness };
}
// ---------------------------------------------------------------------------
// done/ manifests
// ---------------------------------------------------------------------------
/**
 * Read every `.yaml` under `.flow/state/done/` (excluding `.snapshot.yaml`
 * sidecars), in alphabetical filename order, parsed via
 * `parseExecutionManifest`. Errors propagate.
 *
 * When `windowStartMs` is non-null (a cycle is open), a manifest is included
 * only when its completion time is at or after the window start. A done/
 * manifest carries no completion timestamp field, so its completion time is the
 * file's mtime — `completeStory` writes the manifest into `done/` at completion,
 * so the mtime is the completion instant. Manifests completed before the cycle
 * opened are excluded (Story native:01KT484NY4HCBPBTT6VEY1Q0CS / AC2). When
 * `windowStartMs` is `null` (no cycle), every manifest is included (baseline).
 */
async function gatherDoneManifests(targetRepoRoot, windowStartMs) {
    const doneDir = path.join(targetRepoRoot, ".flow", "state", "done");
    let entries;
    try {
        entries = await fs.readdir(doneDir);
    }
    catch (err) {
        if (isEnoent(err)) {
            return [];
        }
        throw err;
    }
    // Filter to manifest .yaml files, exclude snapshot sidecars (Story 5.29),
    // and sort alphabetically for deterministic ordering.
    const manifestFiles = entries
        .filter((f) => f.endsWith(".yaml") && !f.endsWith(".snapshot.yaml"))
        .sort();
    const manifests = [];
    for (const file of manifestFiles) {
        const absPath = path.join(doneDir, file);
        // Cycle scoping: skip manifests completed before the window opened. The
        // completion instant is the file mtime (see fn JSDoc). The stat precedes
        // the read so an out-of-window manifest is not even parsed.
        if (windowStartMs !== null) {
            const stat = await fs.stat(absPath);
            if (stat.mtimeMs < windowStartMs) {
                continue;
            }
        }
        const raw = await fs.readFile(absPath, "utf8");
        const parsed = yamlParse(raw);
        // parseExecutionManifest throws MalformedExecutionManifestError on
        // invalid shape — propagated, not swallowed.
        manifests.push(parseExecutionManifest(parsed, { absPath }));
    }
    return manifests;
}
// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------
/**
 * Read every `.jsonl` under `.flow/telemetry/` in alphabetical filename
 * order; parse each non-empty line through `TelemetryEventSchema`.
 * Malformed lines (bad JSON or failed Zod) are skipped and counted.
 *
 * When `windowStartMs` is non-null (a cycle is open), only events whose `ts` is
 * at or after the window start are returned; events from before the cycle
 * opened are excluded (NOT counted as skipped — they are valid, just
 * out-of-window). When `windowStartMs` is `null` (no cycle), every valid event
 * is returned (the existing baseline). Story
 * native:01KT484NY4HCBPBTT6VEY1Q0CS / AC2 + AC4.
 */
async function gatherTelemetry(targetRepoRoot, windowStartMs) {
    const telemetryDir = path.join(targetRepoRoot, ".flow", "telemetry");
    let entries;
    try {
        entries = await fs.readdir(telemetryDir);
    }
    catch (err) {
        if (isEnoent(err)) {
            return { events: [], skipped_count: 0 };
        }
        throw err;
    }
    const files = entries.filter((f) => TELEMETRY_FILE_REGEX.test(f)).sort();
    const events = [];
    let skipped_count = 0;
    for (const file of files) {
        const absPath = path.join(telemetryDir, file);
        const raw = await fs.readFile(absPath, "utf8");
        const lines = raw.split("\n");
        for (const line of lines) {
            if (line.trim() === "") {
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                skipped_count++;
                continue;
            }
            const result = TelemetryEventSchema.safeParse(parsed);
            if (!result.success) {
                skipped_count++;
                continue;
            }
            // Cycle scoping: drop events timestamped before the window opened. These
            // are valid events outside the current cycle, NOT corrupt lines, so they
            // do not increment skipped_count.
            if (windowStartMs !== null && Date.parse(result.data.ts) < windowStartMs) {
                continue;
            }
            events.push(result.data);
        }
    }
    return { events, skipped_count };
}
// ---------------------------------------------------------------------------
// prior proposals
// ---------------------------------------------------------------------------
/**
 * List every `.flow/retro-proposals/*.md` as `{ path, iso_timestamp }`,
 * sorted by ISO timestamp ascending. The timestamp is derived from the
 * filename stem (Story 6.3 keys files by ISO timestamp). Contents are NOT
 * loaded — the analyst reads them via the `Read` tool if needed.
 *
 * `path` is the absolute path so the analyst can `Read` it directly.
 */
async function gatherPriorProposals(targetRepoRoot) {
    const proposalsDir = path.join(targetRepoRoot, ".flow", "retro-proposals");
    let entries;
    try {
        entries = await fs.readdir(proposalsDir);
    }
    catch (err) {
        if (isEnoent(err)) {
            return [];
        }
        throw err;
    }
    const proposals = entries
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({
        path: path.join(proposalsDir, f),
        // The writer keys the filename by ISO timestamp (Story 6.3):
        // `<isoTimestamp>.md`. Strip the `.md` suffix to recover it.
        iso_timestamp: f.slice(0, -".md".length),
    }));
    // Sort by ISO timestamp ascending. ISO-8601 strings sort
    // lexicographically in chronological order.
    proposals.sort((a, b) => a.iso_timestamp.localeCompare(b.iso_timestamp));
    return proposals;
}
// ---------------------------------------------------------------------------
// rule registry
// ---------------------------------------------------------------------------
/**
 * Read `<targetRepoRoot>/docs/discipline-rules.yaml` through the validated,
 * comment-preserving parser (`parseRuleRegistry`, Story 6.5), or return `null`
 * when absent. Absence is NOT an error — null-tolerance matches the analyst's
 * `ruleRegistry: null` contract. A present-but-malformed registry now raises a
 * typed `RuleRegistryMalformedError` (a corrupt registry is a hard stop, like a
 * corrupt done/ manifest — not a silently-swallowed line).
 *
 * Returns the schema-validated `{ rules }` view (not the comment-carrying
 * Document) — the analyst reasons over the rules, the apply handler is the only
 * caller that needs the comment-preserving Document.
 */
async function gatherRuleRegistry(targetRepoRoot) {
    const registryPath = path.join(targetRepoRoot, "docs", "discipline-rules.yaml");
    let raw;
    try {
        raw = await fs.readFile(registryPath, "utf8");
    }
    catch (err) {
        if (isEnoent(err)) {
            return null;
        }
        throw err;
    }
    // Validated parse — raises RuleRegistryMalformedError on a bad registry.
    return parseRuleRegistry(raw, "docs/discipline-rules.yaml").data;
}
// ---------------------------------------------------------------------------
// recurring friction
// ---------------------------------------------------------------------------
/**
 * Compute the recurring-friction signal from the cycle's telemetry events.
 *
 * Groups `agent.friction` events by `kind`, then returns only those kinds
 * whose count reaches the threshold (count >= 2). One-off friction (count < 2)
 * is excluded to avoid flooding the retro with noise.
 *
 * The analyst MUST consume `recurringFriction` only — it MUST NOT recount
 * from raw telemetry, mirroring the `fireCountSignal` discipline.
 */
function computeRecurringFriction(events) {
    const RECURRING_THRESHOLD = 2;
    // Accumulate counts per kind.
    const counts = new Map();
    for (const event of events) {
        if (event.type === "agent.friction") {
            // Narrow to AgentFrictionEvent for type-safe access to data.kind.
            const frictionEvent = event;
            const kind = frictionEvent.data.kind;
            counts.set(kind, (counts.get(kind) ?? 0) + 1);
        }
    }
    // Return only kinds at or above the threshold, sorted by kind for determinism.
    const result = [];
    for (const [kind, count] of counts) {
        if (count >= RECURRING_THRESHOLD) {
            result.push({ kind, count });
        }
    }
    result.sort((a, b) => a.kind.localeCompare(b.kind));
    return result;
}
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function isEnoent(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
