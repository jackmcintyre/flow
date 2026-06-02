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
export const RepoSignalsSchema = z
  .object({
    targetRepoRoot: z.string().min(1),
    languages: z.array(z.string().min(1)),
    topLevelLayout: z.array(z.string().min(1)),
    readmeExcerpt: z.string(),
    recentCommitTitles: z.array(z.string()),
    dependencyManifests: z.array(z.string().min(1)),
  })
  .strict();

export type RepoSignals = z.infer<typeof RepoSignalsSchema>;
