import { z } from "zod";
import { LESSON_KINDS } from "./story-retro.js";

/**
 * Typed return shape of the `getTeamSnapshot` MCP tool (Story 2.6).
 *
 * Per-role result uses a discriminated union on `state`:
 *  - `"ok"` — fully populated role stanza.
 *  - `"error"` — persona file failed to parse; only `role` and `error`
 *    are present (not null — structurally absent per AC3(d)).
 *
 * `renderTeamSnapshot(snapshot)` consumes this shape unchanged.
 *
 * Knowledge entries are now structured (Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4):
 * each entry carries its `kind`, `applies_when` summary, optional `source_ref`,
 * and full `detail` text so `/flow:team` can render a meaningful digest instead
 * of undifferentiated bullet text.
 */

const KEBAB_ROLE_REGEX = /^[a-z0-9-]+$/;

/**
 * A single structured knowledge entry as rendered by `getTeamSnapshot`.
 *
 * - `kind`         — closed lesson-kind enum (pitfall|pattern|tool-quirk|discipline).
 * - `applies_when` — short summary line shown in the /flow:team display.
 * - `detail`       — full lesson text.
 * - `source_ref`   — optional story ref provenance.
 */
export const KnowledgeEntrySchema = z
  .object({
    kind: z.enum(LESSON_KINDS),
    applies_when: z.string().min(1),
    detail: z.string().min(1),
    source_ref: z.string().min(1).optional(),
  })
  .strict();

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export const TeamSnapshotRoleSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    role: z.string().min(1).regex(KEBAB_ROLE_REGEX),
    domain: z.string().min(1),
    fireCount: z.number().int().nonnegative(),
    knowledge: z.array(KnowledgeEntrySchema),
  }),
  z.object({
    state: z.literal("error"),
    role: z.string().min(1).regex(KEBAB_ROLE_REGEX),
    error: z.string().min(1),
  }),
]);

export type TeamSnapshotRole = z.infer<typeof TeamSnapshotRoleSchema>;

export const TeamSnapshotSchema = z
  .object({
    roles: z.array(TeamSnapshotRoleSchema),
    knowledgeLimit: z.number().int().positive(),
    malformedTelemetryLines: z.number().int().nonnegative(),
    malformedTelemetryFiles: z.number().int().nonnegative(),
  })
  .strict();

export type TeamSnapshot = z.infer<typeof TeamSnapshotSchema>;
