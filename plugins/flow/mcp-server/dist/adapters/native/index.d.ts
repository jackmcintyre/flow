import type { PlanningAdapter } from "../adapter.js";
import { parseNativeStory } from "./parse-native-story.js";
type NativeContext = {
    targetRepo: string;
};
/**
 * Configure the bound `targetRepo` context the adapter's list/read/resolve
 * methods operate against. Called by `resolveWorkspace` (via the adapter
 * branch in workspace-resolver.ts) and by tests.
 */
export declare function configureNativeAdapter(ctx: NativeContext): void;
/** Reset the bound context — primarily for test cleanup. */
export declare function resetNativeAdapter(): void;
export declare const NativeAdapter: PlanningAdapter;
export { parseNativeStory };
