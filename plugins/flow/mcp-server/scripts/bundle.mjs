#!/usr/bin/env node
// @ts-check
/**
 * Bundle the MCP server entrypoints into self-contained ESM files.
 *
 * Why this exists
 * ---------------
 * `tsc` emits `dist/index.js` and `dist/cli.js` with bare imports
 * (`@modelcontextprotocol/sdk`, `execa`, `zod`, …) that resolve from
 * `node_modules` at runtime. A plugin installed from a GitHub marketplace — or
 * onto a clean machine — ships only committed files, NOT `node_modules`, so the
 * unbundled server dies on boot with `ERR_MODULE_NOT_FOUND`. The current local
 * directory install only works because it copies the dev machine's
 * `node_modules` into the plugin cache.
 *
 * This step inlines every third-party dependency into each entrypoint so the
 * plugin runs from any install. Pattern mirrors `context-mode` (esbuild +
 * `assert-bundle`). See memory `plugin-not-bundled-install-broken`.
 *
 * Outputs overwrite the tsc stubs at the SAME paths that
 * `.claude-plugin/plugin.json#mcpServers` and `workflows/internal/run.workflow.js`
 * already reference, so no caller path changes. Wired into `pnpm build` after
 * `tsc` + `normalise-dist`.
 *
 * All six runtime deps are pure JS → nothing is marked `external`. Node builtins
 * stay external (they ship with node, so a clean install still resolves them).
 */
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Output dir is overridable (CREW_BUNDLE_OUT_DIR) so the dist-shipping drift test
// can reproduce the full build into a temp dir and compare against committed dist.
// Defaults to the real dist/. Entry sources are always the real src/.
const OUT_DIR = process.env["CREW_BUNDLE_OUT_DIR"]
  ? path.resolve(process.env["CREW_BUNDLE_OUT_DIR"])
  : path.join(ROOT, "dist");

/** @type {{ entry: string; out: string; metaOut: string }[]} */
const ENTRYPOINTS = [
  { entry: "src/index.ts", out: "index.js", metaOut: "bundle-meta-index.json" }, // MCP stdio server (plugin.json)
  { entry: "src/cli.ts", out: "cli.js", metaOut: "bundle-meta-cli.json" }, //     stateless CLI seam (run)
];

for (const { entry, out, metaOut } of ENTRYPOINTS) {
  const result = await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(OUT_DIR, out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    // Emit esbuild's dependency graph so bundle-coverage.test.ts can diff it
    // against the full src/ tree to surface dead modules. The metafile is
    // written beside the bundle so the same CREW_BUNDLE_OUT_DIR override that
    // lets the drift test do a temp-dir rebuild also redirects the metafiles.
    metafile: true,
    // NOT minified — deliberately. Minification mangles class names, and the
    // the run classifies failures on `DomainError.name` (the class name, e.g.
    // `NotAnEligibleBacklogItemError`). A minified bundle returns `name: "un"`,
    // silently breaking error routing on a clean install. (esbuild `keepNames`
    // would preserve `.name`, but on this load-bearing path the unminified bundle
    // is the obviously-correct choice; the size cost is acceptable for committed,
    // drift-checked build output.)
    // Some CJS deps reference a CommonJS `require`. Under ESM output esbuild has
    // no ambient `require`, so provide the real one via createRequire — this makes
    // esbuild's `__require` helper take its `typeof require !== "undefined"` branch
    // and resolve node builtins instead of hitting the throwing fallback. The
    // leading marker is the stable signal assert-bundle.mjs greps for (the alias
    // name is otherwise free to change). Aliased to avoid colliding with any
    // `createRequire` esbuild may hoist from bundled deps.
    banner: {
      js:
        "// flow:require-banner — createRequire shim so bundled CJS `require()` works under ESM (see scripts/assert-bundle.mjs)\n" +
        "import { createRequire as __flowCreateRequire } from 'node:module';\n" +
        "const require = __flowCreateRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  // Write the metafile beside the bundle so bundle-coverage.test.ts can read it.
  // The metafile records every input file esbuild pulled into the bundle, giving
  // the coverage check a ground-truth reachable set to diff against src/**/*.ts.
  await writeFile(path.join(OUT_DIR, metaOut), JSON.stringify(result.metafile));
  console.log(`bundle: ${entry} -> ${out} (metafile: ${metaOut})`);
}
