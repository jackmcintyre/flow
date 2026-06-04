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
] as const;

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
 * Inferred type for a single retro lesson (the existing `LessonSchema` shape —
 * NOT a new lesson type). Exported so the learning-loop producer
 * (`recordReviewerLesson`, the reviewer-result projection) can type the lesson
 * it captures off the one canonical schema.
 */
export type Lesson = z.infer<typeof LessonSchema>;

/**
 * Schema for a structured lesson entry stored in a role's Knowledge section.
 *
 * Reuses `LessonSchema`'s vocabulary (kind + failure_class) and extends it
 * with provenance fields so `/flow:team` can show kind and source for every
 * entry instead of undifferentiated bullet text.
 *
 * Fields:
 *  - `id`          — ULID that uniquely identifies this lesson entry.
 *  - `kind`        — Closed enum from `LESSON_KINDS` (pitfall|pattern|tool-quirk|discipline).
 *  - `applies_when`— Short sentence describing when this lesson is relevant (shown in /flow:team).
 *  - `detail`      — Full lesson text (the original lesson prose).
 *  - `failure_class` — Required when `kind === "pitfall"` (mirrors LessonSchema contract).
 *  - `source_ref`  — Optional story ref the lesson came from (e.g. `native:01KT...`).
 *  - `source_pr`   — Optional PR URL for traceability.
 *  - `learned_at`  — ISO-8601 UTC timestamp when the lesson was appended.
 *  - `use_count`   — Optional non-negative integer. Incremented by `recallLesson` each time
 *                    an agent retrieves this lesson's full detail. Used by the briefing-budget
 *                    ranker (Story native:01KT6QSW4W7SMAHAT4EAKCCC65) to keep frequently-used
 *                    lessons in the always-shown index.
 *  - `last_used_at`— Optional ISO-8601 UTC timestamp of the most recent `recallLesson` call.
 *                    Secondary sort key in the briefing-budget ranker (most-recently-used first
 *                    when use_count is equal).
 *
 * `.strict()` rejects unknown keys.
 */
export const StructuredLessonSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[0-9A-HJKMNP-TV-Z]{26}$/,
        "id must be a 26-char Crockford base32 ULID",
      ),
    kind: z.enum(LESSON_KINDS),
    applies_when: z.string().min(1),
    detail: z.string().min(1),
    failure_class: z.string().min(1).optional(),
    source_ref: z.string().min(1).optional(),
    source_pr: z.string().min(1).optional(),
    learned_at: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
        "learned_at must be ISO-8601 UTC (Z-suffixed)",
      ),
    // Usage-tracking fields added by Story native:01KT6QSW4W7SMAHAT4EAKCCC65.
    // Optional so old lessons without them remain valid; ranker treats absent
    // fields as use_count=0 / last_used_at=epoch for ordering purposes.
    use_count: z.number().int().nonnegative().optional(),
    last_used_at: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
        "last_used_at must be ISO-8601 UTC (Z-suffixed)",
      )
      .optional(),
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

export type StructuredLesson = z.infer<typeof StructuredLessonSchema>;

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

export type StoryRetroPayload = z.infer<typeof StoryRetroPayloadSchema>;

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
export function parseStoryRetroPayload(input: unknown): StoryRetroPayload {
  const result = StoryRetroPayloadSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const yamlPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new MalformedStoryRetroPayloadError({
      yamlPath,
      zodMessage: issue.message,
      schemaModule: "mcp-server/src/schemas/story-retro.ts",
    });
  }
  return result.data;
}
