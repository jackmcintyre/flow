import { z } from "zod";
import { type StateName } from "../state/manifest-state-machine.js";
export declare const MarkStoryReadyInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    ref: z.ZodString;
    ready: z.ZodBoolean;
    sessionUlid: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export interface MarkStoryReadyOutput {
    ref: string;
    ready: boolean;
    /** True when the flag already held the requested value (no write, no event). */
    noop: boolean;
    state: StateName;
    absPath?: string;
}
/**
 * Set (or clear) the `ready` flag on an un-claimed backlog manifest.
 *
 * @throws {NotAnEligibleBacklogItemError} if the ref does not resolve to an
 *   un-claimed backlog item in `to-do/` (absent, withdrawn, or in another state).
 * @throws {MalformedExecutionManifestError} if the manifest fails schema validation.
 */
export declare function markStoryReady(rawInput: unknown): Promise<MarkStoryReadyOutput>;
