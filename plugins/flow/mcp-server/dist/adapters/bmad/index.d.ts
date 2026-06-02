import { AmbiguousBmadRefError, MalformedBmadStoryError, UnknownBmadRefError } from "../../errors.js";
import type { PlanningAdapter } from "../adapter.js";
import { parseBmadStory } from "./parse-bmad-story.js";
import { mapBmadStatusToExecution, reconcileStatus, type BmadStatus, type ExecutionState, type ReconciliationOutcome } from "./map-bmad-status.js";
type BmadContext = {
    targetRepo: string;
    storiesRoot: string;
};
/**
 * Configure the bound `(targetRepo, storiesRoot)` context the adapter's
 * list/read/resolve methods operate against. Called by the runtime
 * (Story 3.1's `getActiveAdapter()`) and by tests.
 */
export declare function configureBmadAdapter(ctx: BmadContext): void;
/** Reset the bound context — primarily for test cleanup. */
export declare function resetBmadAdapter(): void;
export declare const BmadAdapter: PlanningAdapter;
export { parseBmadStory, mapBmadStatusToExecution, reconcileStatus, MalformedBmadStoryError, UnknownBmadRefError, AmbiguousBmadRefError, };
export type { BmadStatus, ExecutionState, ReconciliationOutcome };
