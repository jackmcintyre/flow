/**
 * Test helper: seed a Flow-SHAPED build home under a tmpdir repo root.
 *
 * Story native:01KVTB3Z made the dev pre-PR gates and the reviewer derive their
 * build/test/bloat toolchain from `resolveProjectToolchain`, which detects the
 * build home STRUCTURALLY (a pnpm-workspace.yaml whose root package.json owns a
 * `build` script → `plugins/flow`, pnpm). Tests that previously relied on the
 * hardcoded `<repo>/plugins/flow` + `pnpm` assumption must now seed that on-disk
 * structure so the resolver lands on the same place — mirroring the real Flow
 * repo's dogfood path on a clean worktree (where `.flow/config.yaml`, being
 * gitignored, is absent).
 *
 * Writes:
 *   <repoRoot>/plugins/flow/package.json        (scripts: build/test/knip)
 *   <repoRoot>/plugins/flow/pnpm-workspace.yaml (packages: [mcp-server])
 *   <repoRoot>/plugins/flow/pnpm-lock.yaml      (so PM detects pnpm)
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";

/** Seed the Flow-shaped build home at `<repoRoot>/plugins/flow`. */
export async function seedFlowShapedBuildHome(repoRoot: string): Promise<string> {
  const flowDir = path.join(repoRoot, "plugins", "flow");
  await fs.mkdir(flowDir, { recursive: true });
  await fs.writeFile(
    path.join(flowDir, "package.json"),
    JSON.stringify(
      {
        name: "flow",
        private: true,
        scripts: {
          build: "pnpm -r build",
          test: "pnpm -r test",
          knip: "knip --no-progress",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(flowDir, "pnpm-workspace.yaml"),
    "packages:\n  - mcp-server\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(flowDir, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
    "utf8",
  );
  return flowDir;
}
