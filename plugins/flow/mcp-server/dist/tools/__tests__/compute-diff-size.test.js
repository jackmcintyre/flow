/**
 * Unit tests for `computeDiffSize` / `isGeneratedDiffPath` (Stage-2 fix):
 * the risk-tier diff-size measurement must count authored SOURCE lines only,
 * excluding committed `dist/` build output and dependency lockfiles — otherwise
 * crew's committed dist roughly doubles a source change's line count and
 * defeats the `low.additive-only` size cap.
 */
import { describe, it, expect } from "vitest";
import { computeDiffSize, isGeneratedDiffPath } from "../run-reviewer-session.js";
const SRC_SECTION = [
    "diff --git a/plugins/flow/mcp-server/src/lib/foo.ts b/plugins/flow/mcp-server/src/lib/foo.ts",
    "new file mode 100644",
    "index 0000000..abc1234",
    "--- /dev/null",
    "+++ b/plugins/flow/mcp-server/src/lib/foo.ts",
    "@@ -0,0 +1,3 @@",
    "+export const a = 1;",
    "+export const b = 2;",
    "+export const c = 3;",
].join("\n");
const DIST_SECTION = [
    "diff --git a/plugins/flow/mcp-server/dist/lib/foo.js b/plugins/flow/mcp-server/dist/lib/foo.js",
    "new file mode 100644",
    "index 0000000..def5678",
    "--- /dev/null",
    "+++ b/plugins/flow/mcp-server/dist/lib/foo.js",
    "@@ -0,0 +1,5 @@",
    "+export const a = 1;",
    "+export const b = 2;",
    "+export const c = 3;",
    "+//# sourceMappingURL=foo.js.map",
    "+export {};",
].join("\n");
const LOCKFILE_SECTION = [
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "index 111..222 100644",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "@@ -1,2 +1,4 @@",
    "+  added: dep",
    "+  another: dep",
    "-  removed: dep",
].join("\n");
describe("isGeneratedDiffPath", () => {
    it("flags dist/ output and lockfiles, not source", () => {
        expect(isGeneratedDiffPath("plugins/flow/mcp-server/dist/lib/foo.js")).toBe(true);
        expect(isGeneratedDiffPath("dist/index.js")).toBe(true);
        expect(isGeneratedDiffPath("pnpm-lock.yaml")).toBe(true);
        expect(isGeneratedDiffPath("a/b/package-lock.json")).toBe(true);
        expect(isGeneratedDiffPath("plugins/flow/mcp-server/src/lib/foo.ts")).toBe(false);
        expect(isGeneratedDiffPath("docs/readme.md")).toBe(false);
    });
});
describe("computeDiffSize — excludes generated output", () => {
    it("counts source lines only; dist section is skipped", () => {
        expect(computeDiffSize(SRC_SECTION + "\n" + DIST_SECTION)).toBe(3);
    });
    it("counts source even when source comes after a dist section", () => {
        expect(computeDiffSize(DIST_SECTION + "\n" + SRC_SECTION)).toBe(3);
    });
    it("a dist-only diff measures 0 source lines", () => {
        expect(computeDiffSize(DIST_SECTION)).toBe(0);
    });
    it("a lockfile-only diff measures 0 source lines", () => {
        expect(computeDiffSize(LOCKFILE_SECTION)).toBe(0);
    });
    it("counts a plain source diff with no generated files", () => {
        expect(computeDiffSize(SRC_SECTION)).toBe(3);
    });
});
