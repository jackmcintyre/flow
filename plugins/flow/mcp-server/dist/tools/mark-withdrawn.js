/**
 * `markWithdrawn` MCP tool — Story 3.6.
 *
 * External-adapter discard path. Flips `withdrawn: false → true` on an
 * execution manifest in-place (same state directory, same filename) using
 * the atomic-write primitive. Native discard uses `writeNativeStory` with
 * a `revert/deprecate:` story instead.
 *
 * Architecture reference: `project-structure-boundaries.md` line 86,
 * `planning-adapter-model.md` §FR78 row.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { ManifestNotFoundError, WrongAdapterError } from "../errors.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { parseExecutionManifest, } from "../schemas/execution-manifest.js";
import { STATE_NAMES } from "../state/manifest-state-machine.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
export const MarkWithdrawnInputSchema = z.object({
    targetRepoRoot: z.string().min(1),
    ref: z.string().min(1),
});
/**
 * Strip keys with `undefined` values before YAML stringification.
 * Mirrors the same helper in `scan-sources.ts` — shared behaviour for
 * manifest serialisation (Story 3.6 Task 3.5 co-location note).
 */
function stripUndefined(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
/**
 * Serialise an `ExecutionManifest` to YAML in canonical form.
 *
 * Uses the same `yaml.stringify` call signature as `scan-sources.ts` so
 * field order and quoting style are byte-identical between a freshly-written
 * manifest and one that has been through `markWithdrawn`. A re-scan after a
 * withdrawal therefore produces no spurious rewrite (idempotency invariant).
 *
 * Co-located with the schema rather than extracted into a separate
 * `lib/manifest-yaml.ts` — single source of truth for serialisation shape.
 * If a future story needs this from a third call-site, extract at that point.
 */
export function serialiseManifest(manifest) {
    return yamlStringify(stripUndefined(manifest), { lineWidth: 0 });
}
/**
 * Mark an execution manifest withdrawn (FR78).
 *
 * External-adapter discard path. Native discard uses `writeNativeStory`
 * with a `revert/deprecate:` story instead.
 *
 * @throws {WrongAdapterError} if the active adapter is `native` — the planner
 *   should route native discard through `writeNativeStory`, not this tool.
 * @throws {ManifestNotFoundError} if no `<ref>.yaml` exists in any state dir.
 * @throws {MalformedExecutionManifestError} if the manifest fails schema validation.
 */
export async function markWithdrawn(rawInput) {
    const input = MarkWithdrawnInputSchema.parse(rawInput);
    const targetRepoRoot = path.resolve(input.targetRepoRoot);
    const { ref } = input;
    // Step 1: Resolve workspace; guard against native adapter.
    // The guard catches planner mis-routing: native discard is writeNativeStory +
    // revert story; markWithdrawn is the external-adapter primitive.
    const workspace = await resolveWorkspace({ targetRepoRoot });
    if (workspace.activeAdapterName === "native") {
        throw new WrongAdapterError({
            expectedAdapter: "non-native",
            actualAdapter: workspace.activeAdapterName,
            targetRepoRoot,
            toolName: "markWithdrawn",
        });
    }
    // Step 2: Scan the four state directories in canonical order for <ref>.yaml.
    const stateRoot = path.join(targetRepoRoot, ".flow", "state");
    let foundState = null;
    let foundAbsPath = null;
    for (const stateName of STATE_NAMES) {
        const candidate = path.join(stateRoot, stateName, `${ref}.yaml`);
        try {
            await fs.stat(candidate);
            foundState = stateName;
            foundAbsPath = candidate;
            break;
        }
        catch {
            // ENOENT — not in this state dir, try next.
        }
    }
    if (foundState === null || foundAbsPath === null) {
        throw new ManifestNotFoundError({
            ref,
            expectedAbsPath: path.join(stateRoot, "to-do", `${ref}.yaml`),
            fromState: "to-do",
        });
    }
    // Step 3: Read and parse the manifest via the canonical reader.
    const rawText = await fs.readFile(foundAbsPath, "utf8");
    const parsed = yamlParse(rawText);
    const manifest = parseExecutionManifest(parsed, { absPath: foundAbsPath });
    // Step 4: Idempotency check — if already withdrawn, return without rewriting.
    if (manifest.withdrawn === true) {
        return {
            ref,
            alreadyWithdrawn: true,
            state: foundState,
        };
    }
    // Step 5: Flip withdrawn to true, re-serialise, and write back atomically.
    // MUST NOT modify any field other than `withdrawn`.
    const updated = { ...manifest, withdrawn: true };
    const yamlText = serialiseManifest(updated);
    await atomicWriteFile(foundAbsPath, yamlText);
    return {
        ref,
        alreadyWithdrawn: false,
        state: foundState,
        absPath: foundAbsPath,
    };
}
