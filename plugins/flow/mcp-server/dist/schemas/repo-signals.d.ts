import { z } from "zod";
/**
 * Typed payload returned by the `readRepoSignals` MCP tool (Story 2.4,
 * FR85). The hiring manager consumes this as initial context to drive a
 * project-shaped team proposal.
 *
 * `.strict()` rejects unknown keys at every level — typos must fail
 * loudly. The schema enforces SHAPE, not the presence of content:
 * missing-signal cases inside `readRepoSignals` (no README, no git
 * history) downgrade to `""` / `[]` defaults. Structural / permission
 * errors propagate.
 *
 * Mirrors the `.strict()` discipline of `StatusReportSchema` (Story 1.7)
 * and `PersonaFrontmatterSchema` (Story 2.3).
 */
export declare const RepoSignalsSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    languages: z.ZodArray<z.ZodString>;
    topLevelLayout: z.ZodArray<z.ZodString>;
    readmeExcerpt: z.ZodString;
    recentCommitTitles: z.ZodArray<z.ZodString>;
    dependencyManifests: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type RepoSignals = z.infer<typeof RepoSignalsSchema>;
