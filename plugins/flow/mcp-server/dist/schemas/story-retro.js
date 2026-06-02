/**
 * Zod schema for story-level retro payloads — Story 6.1.
 *
 * The retro payload is attached to a `done/<ref>.yaml` manifest by the
 * `recordStoryRetro` MCP tool (Story 6.1, FR11, FR55) after a story has
 * completed. It carries:
 *   - `lessons[]` — structured retro entries with a closed `kind` enum.
 *   - `failure_class` — optional story-level failure-class label.
 *   - `duration_seconds` — optional non-negative integer.
 *
 * **Deterministic seam:** `lessons[].kind` is a CLOSED `z.enum` — no
 * `z.string()` fallback. Unknown kinds are caught at the Zod boundary so
 * the routing contract for Story 6.3 (`kind` → proposal-type) cannot be
 * silently eroded by future writers. See memory
 * `feedback_default_to_deterministic_seams`.
 *
 * **`failure_class` taxonomy:** Free-text in v1 by design — Story 6.2/6.3
 * will narrow it after the retro-analyst defines the closed set. Don't
 * introduce a closed enum prematurely; the `project_ac_marker_gap` memory
 * shows the cost of mistuned vocabularies.
 *
 * **`routed_to` taxonomy:** Free-text label naming a downstream proposal
 * kind (rule, skill-create, etc.) when the retro-analyst has decided.
 * v1 accepts any non-empty string; Story 6.2 will close the enum when
 * the proposal-type taxonomy lands. This is the explicit forward-compat
 * hole.
 */
import { z } from "zod";
import { MalformedStoryRetroPayloadError } from "../errors.js";
/**
 * Closed enum of retro-lesson kinds (Story 6.1 AC2).
 *
 * Each kind maps to a downstream proposal-type in Story 6.3 (FR11).
 * Adding a new kind requires a deliberate schema-change story — never
 * relax to `z.string()` here.
 */
export const LESSON_KINDS = [
    "pitfall",
    "pattern",
    "tool-quirk",
    "discipline",
];
/**
 * Schema for a single retro lesson.
 *
 * - `kind` — closed enum (no string fallback).
 * - `text` — required, non-empty.
 * - `failure_class` — REQUIRED when `kind === "pitfall"`, optional otherwise
 *   (enforced via `superRefine`).
 * - `routed_to` — optional.
 *
 * `.strict()` rejects unknown keys.
 */
export const LessonSchema = z
    .object({
    kind: z.enum(LESSON_KINDS),
    text: z.string().min(1),
    failure_class: z.string().min(1).optional(),
    routed_to: z.string().min(1).optional(),
})
    .strict()
    .superRefine((lesson, ctx) => {
    if (lesson.kind === "pitfall" && lesson.failure_class === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["failure_class"],
            message: "failure_class is required when kind is 'pitfall'",
        });
    }
});
/**
 * Schema for the full retro payload accepted by `recordStoryRetro`.
 *
 * - `lessons` — array of `LessonSchema`, defaults to `[]`.
 * - `failure_class` — optional non-empty string (story-level).
 * - `duration_seconds` — optional non-negative integer.
 *
 * `.strict()` rejects unknown keys.
 */
export const StoryRetroPayloadSchema = z
    .object({
    lessons: z.array(LessonSchema).default([]),
    failure_class: z.string().min(1).optional(),
    duration_seconds: z.number().int().nonnegative().optional(),
})
    .strict();
/**
 * Canonical parser for story retro payloads.
 *
 * **Every caller MUST go through this helper** — it is the only place
 * that maps Zod validation failures to the typed
 * `MalformedStoryRetroPayloadError`. Mirrors `parseExecutionManifest`'s
 * shape.
 *
 * @param input - The raw payload (unknown shape — validated inside).
 * @throws {MalformedStoryRetroPayloadError} When `input` fails schema
 *   validation.
 */
export function parseStoryRetroPayload(input) {
    const result = StoryRetroPayloadSchema.safeParse(input);
    if (!result.success) {
        const issue = result.error.issues[0];
        const yamlPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
        throw new MalformedStoryRetroPayloadError({
            yamlPath,
            zodMessage: issue.message,
            schemaModule: "mcp-server/src/schemas/story-retro.ts",
        });
    }
    return result.data;
}
