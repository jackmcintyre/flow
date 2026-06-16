/**
 * Zod schema for structured maintainer-feedback items — Story native:01KV7FHZ41Z6CFPABW1B8J38BV.
 *
 * A maintainer-feedback item captures a structural limitation of the tool itself
 * that a role encountered during its work. It is routed to a maintainer-only inbox
 * that the team never reads to drive its own behaviour. The maintainer reviews the
 * inbox and decides whether to act on each item.
 *
 * Each item MUST be self-contained so the maintainer can act on it without
 * going back to the originating role. That invariant is enforced at the schema
 * boundary — any item missing `problem`, `tool_area`, or `trigger` is refused
 * rather than stored.
 *
 * **Deterministic seam:** every write goes through `parseMaintainerFeedbackItem`
 * (which maps Zod failures to `MalformedMaintainerFeedbackError`) before
 * hitting disk. Mirrors the pattern in `story-retro.ts`.
 *
 * **Accumulation, not overwrite:** items are written as individual files under
 * `.flow/maintainer-inbox/` (one file per item, timestamped filename) so
 * they accumulate as distinct entries and nothing is ever lost. The inbox is
 * explicitly NOT under `.flow/state/**` — the team never reads it to drive
 * its own behaviour.
 */

import { z } from "zod";
import { MalformedMaintainerFeedbackError } from "../errors.js";

/**
 * Schema for a single maintainer-feedback item.
 *
 * Required fields (refused if missing — AC2):
 *   - `problem`    — What is wrong / what structural limitation was hit.
 *   - `tool_area`  — Which part of the tool the problem concerns.
 *   - `trigger`    — What surfaced this: which role / phase / story triggered it.
 *
 * Optional field:
 *   - `suggested_direction` — A concrete suggestion for how to fix or improve.
 *
 * Provenance fields (stamped by the tool, not supplied by the caller):
 *   - `id`         — Unique identifier (ULID) for this item.
 *   - `raised_at`  — ISO-8601 UTC timestamp when the item was recorded.
 *
 * `.strict()` rejects unknown keys so the inbox stays schema-clean.
 */
export const MaintainerFeedbackItemSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[0-9A-HJKMNP-TV-Z]{26}$/,
        "id must be a 26-char Crockford base32 ULID",
      ),
    raised_at: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
        "raised_at must be ISO-8601 UTC (Z-suffixed)",
      ),
    problem: z.string().min(1, "problem must be a non-empty string"),
    tool_area: z.string().min(1, "tool_area must be a non-empty string"),
    trigger: z.string().min(1, "trigger must be a non-empty string"),
    suggested_direction: z.string().min(1).optional(),
  })
  .strict();

export type MaintainerFeedbackItem = z.infer<typeof MaintainerFeedbackItemSchema>;

/**
 * Schema for the caller-supplied payload (before the tool stamps `id` and
 * `raised_at`). This is what `recordMaintainerFeedback` validates against
 * the caller's input — the tool adds provenance before writing.
 */
const MaintainerFeedbackInputSchema = z
  .object({
    problem: z.string().min(1, "problem must be a non-empty string"),
    tool_area: z.string().min(1, "tool_area must be a non-empty string"),
    trigger: z.string().min(1, "trigger must be a non-empty string"),
    suggested_direction: z.string().min(1).optional(),
  })
  .strict();

export type MaintainerFeedbackInput = z.infer<typeof MaintainerFeedbackInputSchema>;

/**
 * Canonical parser for caller-supplied maintainer feedback payloads.
 *
 * **Every caller MUST go through this helper** — it maps Zod validation
 * failures to `MalformedMaintainerFeedbackError`. Mirrors
 * `parseStoryRetroPayload`'s shape.
 *
 * @param input - The raw payload (unknown shape — validated inside).
 * @throws {MalformedMaintainerFeedbackError} When `input` fails schema
 *   validation (missing required field, non-empty-string constraint,
 *   unknown key).
 */
export function parseMaintainerFeedbackInput(input: unknown): MaintainerFeedbackInput {
  const result = MaintainerFeedbackInputSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const fieldPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new MalformedMaintainerFeedbackError({
      fieldPath,
      zodMessage: issue.message,
      schemaModule: "mcp-server/src/schemas/maintainer-feedback.ts",
    });
  }
  return result.data;
}
