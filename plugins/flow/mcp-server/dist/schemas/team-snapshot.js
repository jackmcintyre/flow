import { z } from "zod";
/**
 * Typed return shape of the `getTeamSnapshot` MCP tool (Story 2.6).
 *
 * Per-role result uses a discriminated union on `state`:
 *  - `"ok"` — fully populated role stanza.
 *  - `"error"` — persona file failed to parse; only `role` and `error`
 *    are present (not null — structurally absent per AC3(d)).
 *
 * `renderTeamSnapshot(snapshot)` consumes this shape unchanged.
 */
const KEBAB_ROLE_REGEX = /^[a-z0-9-]+$/;
export const TeamSnapshotRoleSchema = z.discriminatedUnion("state", [
    z.object({
        state: z.literal("ok"),
        role: z.string().min(1).regex(KEBAB_ROLE_REGEX),
        domain: z.string().min(1),
        fireCount: z.number().int().nonnegative(),
        knowledge: z.array(z.string()),
    }),
    z.object({
        state: z.literal("error"),
        role: z.string().min(1).regex(KEBAB_ROLE_REGEX),
        error: z.string().min(1),
    }),
]);
export const TeamSnapshotSchema = z
    .object({
    roles: z.array(TeamSnapshotRoleSchema),
    knowledgeLimit: z.number().int().positive(),
    malformedTelemetryLines: z.number().int().nonnegative(),
    malformedTelemetryFiles: z.number().int().nonnegative(),
})
    .strict();
