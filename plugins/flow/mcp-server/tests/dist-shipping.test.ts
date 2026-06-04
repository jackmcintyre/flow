import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Story 1.9 — Ship a pre-built dist/ with the plugin.
 *
 * Only the two self-contained esbuild bundles are committed under dist/:
 *   - dist/index.js — the MCP stdio server (.claude-plugin/plugin.json)
 *   - dist/cli.js   — the stateless CLI seam (workflows)
 * The rest of the tsc dist tree is gitignored (see mcp-server/.gitignore). The
 * bundles inline every dependency, so these two files are all a clean-machine
 * `/plugin install` loads at runtime. scripts/assert-clean-install.mjs is the
 * runtime ground-truth gate (boots the server from ONLY these two files); this
 * suite mirrors the shipping + drift contract in the test runner.
 *
 * Two blocks:
 *  (a) SHIPPING CONTRACT — the two bundles are present and dist/index.js boots
 *      without a module-resolution error (the partial-build regression, PR #61).
 *  (b) DRIFT — re-bundle src/ into a temp dir and assert the committed bundles
 *      match byte-for-byte. Mirrors the CI `git diff --exit-code` gate.
 *
 * For the index.js boot check we spawn a short-lived child process rather than
 * importing in-process — `dist/index.js` calls `main()` at module top level,
 * which connects an stdio transport and would hang the test worker.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..");
const DIST_DIR = resolve(SERVER_ROOT, "dist");
const INDEX_DIST = resolve(DIST_DIR, "index.js");
const CLI_DIST = resolve(DIST_DIR, "cli.js");
const COMMITTED_BUNDLES = ["index.js", "cli.js"];

describe("dist shipping contract (Story 1.9)", () => {
  describe("shipping contract: the two committed bundles are present and boot", () => {
    it("dist/index.js and dist/cli.js exist", async () => {
      await expect(access(INDEX_DIST)).resolves.toBeUndefined();
      await expect(access(CLI_DIST)).resolves.toBeUndefined();
    });

    it("dist/index.js starts as a node module without a module-resolution crash", async () => {
      // Spawn the entrypoint with stdin closed. The server connects an stdio
      // transport and waits for input; closing stdin lets it shut down. If the
      // bundle failed to inline a dependency — or reached for a now-untracked
      // loose dist file — it exits non-zero with MODULE_NOT_FOUND on stderr.
      // A timeout (process kept running waiting for stdio) is the OK outcome.
      const result = await execa("node", [INDEX_DIST], {
        reject: false,
        timeout: 1500,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = result.stderr ?? "";
      expect(stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/);
    });
  });

  describe("drift: a fresh bundle of src/ matches the committed bundles", () => {
    it("index.js + cli.js are byte-equal to a fresh esbuild bundle", async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), "flow-dist-drift-"));
      try {
        // bundle.mjs reads entry sources from the real src/ and writes the two
        // bundles to CREW_BUNDLE_OUT_DIR — exactly what `pnpm build` and the CI
        // drift gate produce for the committed files.
        await execa("node", ["scripts/bundle.mjs"], {
          cwd: SERVER_ROOT,
          env: { ...process.env, CREW_BUNDLE_OUT_DIR: tmpRoot },
        });

        const divergent: string[] = [];
        for (const rel of COMMITTED_BUNDLES) {
          const committed = await readFile(join(DIST_DIR, rel));
          const fresh = await readFile(join(tmpRoot, rel));
          if (!committed.equals(fresh)) divergent.push(rel);
        }
        expect(divergent).toEqual([]);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    }, 60_000);
  });
});
