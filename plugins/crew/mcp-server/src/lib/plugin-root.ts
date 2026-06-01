import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path of the plugin root (`plugins/crew/`) by walking up
 * from this module's location until the `.claude-plugin/plugin.json` marker is
 * found.
 *
 * Why a marker-walk instead of a fixed `../../..`: the previous hard-coded depth
 * assumed this file always sits at `mcp-server/dist/lib/`. Once the server is
 * bundled (esbuild → `dist/index.js`, one directory shallower) that arithmetic
 * points one level too high. Searching upward for the marker is correct in every
 * layout this module runs in:
 *   - src/lib/plugin-root.ts          (vitest)
 *   - mcp-server/dist/lib/...         (unbundled tsc output)
 *   - mcp-server/dist/index.js|cli.js (bundled entrypoints)
 *   - ~/.claude/plugins/cache/.../<v>/mcp-server/... (installed plugin)
 * In all of them the nearest ancestor carrying `.claude-plugin/plugin.json` is
 * the plugin root. The walk starts from the module, never `process.cwd()`, so a
 * target repo's own `.claude-plugin/` can never shadow it.
 *
 * Used by the MCP tool handlers in `register.ts` to obtain the plugin root for
 * `readCatalogue` and `instantiatePersona`, by `plugin-version.ts`, and by
 * `create-smoke-scratch-repo.ts` for the shipped standards template.
 */
export function getPluginRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  const { root } = path.parse(dir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
      return dir;
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  throw new Error(
    `getPluginRoot: could not locate .claude-plugin/plugin.json above ${start}`,
  );
}
