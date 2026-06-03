/**
 * Allowlist-pin regression test for `loadRolePermissions` — Story 5.34 AC1 + AC3.
 *
 * AC1: Literal content-structure check — reads the raw YAML bytes of the
 *      production `generalist-dev.yaml` and asserts that `repo-view` and `api`
 *      appear as literal list entries in addition to the pre-existing entries
 *      (pr-create, pr-view, pr-comment, pr-merge). No parsed view — raw text.
 *
 * AC3: Reads the PRODUCTION `generalist-dev.yaml` via the real `loadRolePermissions`
 *      loader (no fixtures, no mocks of the permission file) and asserts that
 *      `gh_allow` is a superset of every subcommand `runAutoMergeGate` can invoke:
 *   - pr-merge  (auto-merge branch)
 *   - repo-view (pause-needs-human branch: gh repo view --json owner,name)
 *   - api       (pause-needs-human branch: gh api POST .../labels)
 *
 * This closes the mock-masking gap surfaced in the bmad:6.3 close-out failure
 * (2026-05-29, PR #180): the gate's existing vitest suite hand-built in-test
 * fixtures that happened to include repo-view + api, so the real generalist-dev
 * allowlist gap was invisible until the gate ran in production.
 *
 * `pluginRoot` is resolved via `import.meta.url` walked up from
 * `src/state/__tests__/` to `plugins/flow/` (four directories up) — same
 * pattern used by `getPluginRoot()` in `lib/plugin-root.ts`.
 *
 * Pure deterministic — no LLM invocation, no network, no temp fixtures.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRolePermissions } from "../load-role-permissions.js";
// ---------------------------------------------------------------------------
// Resolve the real plugin root from this file's location.
//
// File layout:
//   plugins/flow/                                       <-- PLUGIN_ROOT
//     mcp-server/src/state/__tests__/                  <-- HERE (this file)
//
// Path: dirname(__file__) / .. / .. / .. / ..  →  plugins/flow/
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const REAL_PERMISSIONS_FILE = path.join(REAL_PLUGIN_ROOT, "permissions", "generalist-dev.yaml");
// ---------------------------------------------------------------------------
// AC1: Literal content-structure check against the production YAML file.
//
// Reads raw YAML bytes — no parser, no loader — and asserts:
//   (a) repo-view and api appear as yaml list entries ("  - <name>")
//   (b) the pre-existing entries pr-create, pr-view, pr-comment, pr-merge
//       are still present (nothing was removed)
//   (c) no other field of the file was changed (role: line still present)
// ---------------------------------------------------------------------------
describe("Story 5.34 — AC1: generalist-dev.yaml literal content-structure check", () => {
    it("raw YAML contains repo-view and api as gh_allow list entries", async () => {
        const raw = await fs.readFile(REAL_PERMISSIONS_FILE, "utf8");
        // Each entry appears as a YAML list item: "  - <name>"
        expect(raw).toMatch(/^\s+-\s+repo-view\s*$/m);
        expect(raw).toMatch(/^\s+-\s+api\s*$/m);
    });
    it("raw YAML still contains all pre-existing gh_allow entries (nothing removed)", async () => {
        const raw = await fs.readFile(REAL_PERMISSIONS_FILE, "utf8");
        const preExisting = ["pr-create", "pr-view", "pr-comment", "pr-merge"];
        for (const entry of preExisting) {
            expect(raw, `pre-existing entry "${entry}" must not be removed`).toMatch(new RegExp(`^\\s+-\\s+${entry}\\s*$`, "m"));
        }
    });
    it("raw YAML role field is unchanged (role: generalist-dev)", async () => {
        const raw = await fs.readFile(REAL_PERMISSIONS_FILE, "utf8");
        expect(raw).toMatch(/^role:\s*generalist-dev\s*$/m);
    });
});
// ---------------------------------------------------------------------------
// AC3: generalist-dev gh_allow must be a superset of the gate's subcommands
// ---------------------------------------------------------------------------
describe("Story 5.34 — AC3: generalist-dev.yaml allowlist pin (production file)", () => {
    it("gh_allow contains pr-merge, repo-view, and api (no fixture — production yaml)", async () => {
        const permissions = await loadRolePermissions({
            role: "generalist-dev",
            pluginRoot: REAL_PLUGIN_ROOT,
        });
        const required = ["pr-merge", "repo-view", "api"];
        for (const subcommand of required) {
            expect(permissions.gh_allow, `generalist-dev.yaml gh_allow must include "${subcommand}" (required by runAutoMergeGate)`).toContain(subcommand);
        }
    });
    it("gh_allow preserves the pre-existing pr-create, pr-view, pr-comment entries", async () => {
        const permissions = await loadRolePermissions({
            role: "generalist-dev",
            pluginRoot: REAL_PLUGIN_ROOT,
        });
        const preExisting = ["pr-create", "pr-view", "pr-comment", "pr-merge"];
        for (const subcommand of preExisting) {
            expect(permissions.gh_allow, `generalist-dev.yaml gh_allow must still contain pre-existing "${subcommand}"`).toContain(subcommand);
        }
    });
});
