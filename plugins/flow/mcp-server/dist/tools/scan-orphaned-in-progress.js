/**
 * `scanOrphanedInProgress` MCP tool — Story 5.11 Task 1.
 *
 * Pure read-only scan of `<targetRepoRoot>/.flow/state/in-progress/` for manifests
 * whose `claimed_by` ULID is defined AND differs from the current session's ULID.
 *
 * Returns orphans in stable alphabetical ref order (sort by filename = ref + .yaml).
 * For each orphan, computes the transcript path and stats it to determine
 * `hasTranscript`, and queries `gh pr list --head <branch>` to determine
 * `hasOpenPR` (Story 5.20 AC1).
 *
 * Manifests whose `claimed_by` is absent (malformed) are silently skipped — they
 * are a different defect class (out of scope for this story, per Behavioural contract).
 *
 * No write side-effects. Propagates `MalformedExecutionManifestError` verbatim.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `scanOrphanedInProgress`.
 * Story 5.11 Task 1.1–1.5. Story 5.20 AC1 adds `hasOpenPR`.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { execa as defaultExeca } from "execa";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { buildBranchSlug } from "../lib/pr-body.js";
import { readDevOutcomeFile } from "../lib/read-dev-outcome-file.js";
/**
 * Scan `<targetRepoRoot>/.flow/state/in-progress/` for orphaned manifests.
 *
 * An orphan is a manifest whose `claimed_by` field is defined and does not match
 * the current `sessionUlid`. Results are sorted alphabetically by ref.
 *
 * Each orphan carries `hasOpenPR: boolean` — derived by running
 * `gh pr list --head <branch> --state open --json number` where `<branch>` is
 * `buildBranchSlug({ ref, title })`. On any `gh` error, defaults to `false`.
 *
 * @throws {MalformedExecutionManifestError} When any manifest fails schema validation.
 */
export async function scanOrphanedInProgress(opts) {
    const { targetRepoRoot, sessionUlid } = opts;
    const execaImpl = opts.execaImpl ?? defaultExeca;
    const inProgressDir = path.join(targetRepoRoot, ".flow", "state", "in-progress");
    const sessionsDir = path.join(targetRepoRoot, ".flow", "state", "sessions");
    // Read in-progress/ directory.
    let entries;
    try {
        entries = await fs.readdir(inProgressDir);
    }
    catch (err) {
        if (isEnoent(err)) {
            return { orphans: [] };
        }
        throw err;
    }
    // Filter to manifest .yaml files and sort alphabetically. Exclude the
    // claim-time sidecar baselines written by claim-story.ts at
    // `<ref>.snapshot.yaml` (Story 5.29) — those mirror only the operator-editable
    // fields and are NOT full execution manifests, so feeding them to
    // parseExecutionManifest throws MalformedExecutionManifestError and blocks the
    // entire orphan-recovery path.
    const yamlEntries = entries
        .filter((f) => f.endsWith(".yaml") && !f.endsWith(".snapshot.yaml"))
        .sort();
    const orphans = [];
    for (const entry of yamlEntries) {
        const absPath = path.join(inProgressDir, entry);
        let raw;
        try {
            raw = await fs.readFile(absPath, "utf8");
        }
        catch (err) {
            if (isEnoent(err)) {
                // File vanished between readdir and readFile — skip silently.
                continue;
            }
            throw err;
        }
        const parsed = yamlParse(raw);
        // parseExecutionManifest throws MalformedExecutionManifestError on invalid shape.
        const manifest = parseExecutionManifest(parsed, { absPath });
        // Skip manifests with absent claimed_by (malformed — different defect class).
        if (!manifest.claimed_by) {
            continue;
        }
        // Skip manifests claimed by the current session.
        if (manifest.claimed_by === sessionUlid) {
            continue;
        }
        // This manifest is an orphan.
        const staleUlid = manifest.claimed_by;
        const transcriptPath = path.join(sessionsDir, staleUlid, "dev-transcript.txt");
        let hasTranscript = false;
        try {
            await fs.stat(transcriptPath);
            hasTranscript = true;
        }
        catch (err) {
            if (!isEnoent(err)) {
                throw err;
            }
            // File absent — hasTranscript stays false.
        }
        // Derive branch name using the canonical convention from buildBranchSlug
        // (same function /ship-story and /flow:start use for dev branches via pr-body.ts).
        // manifest.title is always present on valid in-progress manifests.
        let hasOpenPR = false;
        // Capture the open PR's number from the SAME gh query so a story whose
        // builder never recorded a dev-outcome.json can still resume at review
        // against the real open PR (instead of being rebuilt from scratch). Reuse
        // the existing query — do NOT add a second gh call. Stays null on any
        // gh/network/parse error so the scan never throws.
        let openPrNumber = null;
        try {
            const branch = buildBranchSlug({ ref: manifest.ref, title: manifest.title });
            const result = await execaImpl("gh", [
                "pr",
                "list",
                "--head",
                branch,
                "--state",
                "open",
                "--json",
                "number",
            ]);
            const parsed = JSON.parse(result.stdout || "[]");
            hasOpenPR = parsed.length > 0;
            openPrNumber = parsed.length > 0 ? (parsed[0]?.number ?? null) : null;
        }
        catch {
            // Network, auth, or parse error — default to false (safe fallback to
            // blockOrphanNoTranscript behaviour). Do NOT throw.
            hasOpenPR = false;
            openPrNumber = null;
        }
        // Recover the PR number (if any) from the stale session's dev-outcome.json
        // so the drain can resume at review without re-running dev. Defensive: a
        // malformed/absent outcome file must NOT abort the whole scan — treat as null.
        //
        // The recorded dev-outcome number always WINS when present (preserves the
        // per-ref cross-attribution fix from native:01KT3YDHM10FPQ77N22BTJP9AF). The
        // open-PR number is the fallback ONLY when the builder never recorded one —
        // covering a crash where a real open PR exists but dev-outcome.json is absent.
        let prNumber = null;
        try {
            const outcome = await readDevOutcomeFile(targetRepoRoot, staleUlid, manifest.ref);
            prNumber = outcome?.prNumber ?? openPrNumber;
        }
        catch {
            prNumber = openPrNumber;
        }
        orphans.push({
            ref: manifest.ref,
            title: manifest.title,
            staleUlid,
            manifestPath: absPath,
            transcriptPath,
            hasTranscript,
            hasOpenPR,
            prNumber,
            resumeAttempts: manifest.drain_resume_attempts ?? 0,
        });
    }
    return { orphans };
}
function isEnoent(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
