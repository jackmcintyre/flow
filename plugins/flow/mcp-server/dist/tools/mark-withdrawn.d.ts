import { z } from "zod";
import { type ExecutionManifest } from "../schemas/execution-manifest.js";
import { type StateName } from "../state/manifest-state-machine.js";
export declare const MarkWithdrawnInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    ref: z.ZodString;
}, z.core.$strip>;
export interface MarkWithdrawnOutput {
    ref: string;
    alreadyWithdrawn: boolean;
    state: StateName;
    absPath?: string;
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
export declare function serialiseManifest(manifest: ExecutionManifest): string;
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
export declare function markWithdrawn(rawInput: unknown): Promise<MarkWithdrawnOutput>;
