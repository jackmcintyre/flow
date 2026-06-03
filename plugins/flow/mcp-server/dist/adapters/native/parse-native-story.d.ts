import type { SourceStory } from "../adapter.js";
/**
 * Pure native-story parser — no I/O. The caller (the adapter's
 * `listSourceStories`/`readSourceStory`) is responsible for reading the
 * file and passing the bytes in.
 *
 * Native story body shape (Story 3.4):
 *   # <Title>  (required)
 *   ## Narrative   (required)
 *   ## Acceptance Criteria  (required, must have ≥1 parseable AC)
 *   ## Implementation Notes (optional)
 *   ## Dependencies (optional, bullet list of refs)
 *
 * @see _bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md § Task 2
 */
export declare function parseNativeStory(absPath: string, fileContents: string): SourceStory;
