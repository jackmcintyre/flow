/**
 * `recordStoryRetro` MCP tool — Story 6.1.
 *
 * Attaches structured retro entries (`lessons[]`, `failure_class`,
 * `duration_seconds`) to a `done/<ref>.yaml` manifest after a story has
 * completed. Reviewer-side tool (Story 6.1, FR11, FR55).
 *
 * Behaviour:
 *   1. Validate `payload` via `parseStoryRetroPayload`
 *      (throws `MalformedStoryRetroPayloadError`).
 *   2. Resolve `done/<ref>.yaml`. If absent at `done/`, check
 *      `in-progress/`, `to-do/`, `blocked/` — if found, throw
 *      `StoryNotInDoneStateError({ ref, foundIn })`. If absent
 *      everywhere, throw `ManifestNotFoundError`.
 *   3. Read the done manifest via `readManifest`.
 *   4. Shallow-overwrite `lessons`, `failure_class`, `duration_seconds` on
 *      the manifest. Do not touch any other field (`rework_count` is owned
 *      by the dev/reviewer cycle).
 *   5. Re-parse the merged document through `parseExecutionManifest` — the
 *      deterministic seam: every write goes back through the validator
 *      before hitting disk.
 *   6. Write via `writeManagedFile` with `mcpToolContext`.
 *
 * **Idempotency:** the merge is a deterministic shallow overwrite, the
 * validator is pure, and YAML stringification with `lineWidth: 0` +
 * `stripUndefined` is byte-stable. Re-running with an identical payload
 * produces a byte-identical file.
 *
 * **No hand-edit guard.** This tool operates on `done/` manifests, which
 * are not subject to the in-progress hand-edit guard
 * (`detectInProgressHandEdit` is keyed to the in-progress layer).
 * Hand-edits to `done/` manifests are operator territory; retro
 * overwrites are the documented intent.
 *
 * FR11 — retro fields on story manifests.
 * FR55 — reviewer records story-level retros.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { ManifestNotFoundError, StoryNotInDoneStateError, } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { readManifest } from "../lib/manifest-io.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { parseStoryRetroPayload } from "../schemas/story-retro.js";
/**
 * The state directories `recordStoryRetro` will inspect for a manifest
 * other than `done/` (for the StoryNotInDoneStateError refusal path).
 */
const NON_DONE_STATES = ["in-progress", "to-do", "blocked"];
/**
 * Strip keys with `undefined` values before YAML stringification.
 * Mirrors the pattern used in `complete-story.ts`, `scan-sources.ts`,
 * and `mark-withdrawn.ts`.
 */
function stripUndefined(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
/**
 * Probe `existsAt(state)/<ref>.yaml` for each non-done state directory,
 * returning the first state that contains the manifest. Returns
 * `undefined` if no state contains the manifest.
 */
async function findInNonDoneState(stateRoot, ref) {
    for (const state of NON_DONE_STATES) {
        const candidate = path.join(stateRoot, state, `${ref}.yaml`);
        try {
            await fs.access(candidate);
            return state;
        }
        catch {
            // ENOENT (or any access failure) → not present in this state, keep looking.
        }
    }
    return undefined;
}
/**
 * Attach a retro payload to a `done/<ref>.yaml` manifest.
 *
 * @returns `{ ref, absPath }` — the ref and absolute path of the
 *   rewritten `done/` manifest.
 *
 * @throws {MalformedStoryRetroPayloadError} When `payload` fails schema
 *   validation (closed-enum violation, missing `failure_class` on a
 *   `pitfall`, unknown key, etc.).
 * @throws {StoryNotInDoneStateError} When the manifest exists but lives
 *   in `to-do/`, `blocked/`, or `in-progress/` rather than `done/`.
 * @throws {ManifestNotFoundError} When the ref does not exist in any
 *   state directory.
 * @throws {MalformedExecutionManifestError} When the merged manifest
 *   fails schema validation (e.g. the on-disk `done/` manifest was
 *   already malformed for an unrelated reason).
 */
export async function recordStoryRetro(opts) {
    const { targetRepoRoot, ref, payload, role = "generalist-reviewer", } = opts;
    // Step 1: Validate the retro payload at the Zod boundary.
    // parseStoryRetroPayload throws MalformedStoryRetroPayloadError on failure.
    const retro = parseStoryRetroPayload(payload);
    // Step 2: Resolve done/<ref>.yaml and probe state-guard if absent.
    const stateRoot = path.join(targetRepoRoot, ".flow", "state");
    const absDonePath = path.join(stateRoot, "done", `${ref}.yaml`);
    let doneExists = true;
    try {
        await fs.access(absDonePath);
    }
    catch {
        doneExists = false;
    }
    if (!doneExists) {
        const foundIn = await findInNonDoneState(stateRoot, ref);
        if (foundIn !== undefined) {
            throw new StoryNotInDoneStateError({ ref, foundIn });
        }
        throw new ManifestNotFoundError({
            ref,
            expectedAbsPath: absDonePath,
            fromState: "done",
        });
    }
    // Step 3: Read the done/ manifest (parses through the validator).
    const manifest = await readManifest(absDonePath);
    // Step 4: Shallow-overwrite retro fields. Leave everything else alone —
    // most notably rework_count, which is owned by the dev/reviewer cycle.
    const merged = {
        ...manifest,
        lessons: retro.lessons,
        failure_class: retro.failure_class,
        duration_seconds: retro.duration_seconds,
    };
    // Step 5: Re-parse through parseExecutionManifest. This is the deterministic
    // seam — every write goes back through the validator before hitting disk.
    const reparsed = parseExecutionManifest(merged, { absPath: absDonePath });
    // Step 6: Atomically write the rewritten manifest.
    const yamlText = yamlStringify(stripUndefined(reparsed), { lineWidth: 0 });
    await writeManagedFile({
        absPath: absDonePath,
        contents: yamlText,
        targetRepoRoot,
        mcpToolContext: { toolName: "recordStoryRetro", role },
    });
    return { ref, absPath: absDonePath };
}
