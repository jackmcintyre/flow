/**
 * Zod schema for `plugins/flow/permissions/gh-error-map.yaml`.
 *
 * **Behavioural contract source:**
 * `_bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md § Behavioural contract`
 *
 * Strict mode (no unknown top-level or per-entry keys). Unknown keys raise
 * `MalformedGhErrorMapError` citing the offending key. (AC1, AC1e, AC3h)
 *
 * Story 4.5 Task 1.1
 */

import { z } from "zod";

/**
 * Single entry in `gh-error-map.yaml`.
 *
 * - `exit_code` — required; the `gh` process exit code to match.
 * - `stderr_regex` — optional; when present, the entry matches only when
 *   the stderr string also matches this pattern (compiled at parse time in
 *   `lib/gh-error-map.ts`). Match logic: exit_code AND (if regex present, regex.test(stderr)).
 * - `class` — required; one of `"defer" | "retry" | "needs-human"`.
 *
 * Strict mode: unknown keys raise a Zod error (MalformedGhErrorMapError in the caller).
 */
const GhErrorMapEntrySchema = z
  .object({
    exit_code: z.number().int(),
    stderr_regex: z.string().optional(),
    class: z.enum(["defer", "retry", "needs-human"]),
  })
  .strict();

/**
 * Top-level shape of `gh-error-map.yaml`.
 *
 * Single key `entries: <list>`. Strict mode rejects unknown top-level keys.
 */
export const GhErrorMapSchema = z
  .object({
    entries: z.array(GhErrorMapEntrySchema),
  })
  .strict();
