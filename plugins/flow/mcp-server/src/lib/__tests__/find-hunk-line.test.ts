/**
 * Unit tests for `find-hunk-line.ts` — Story 4.6b Task 9.
 */

import { describe, expect, it } from "vitest";
import { findHunkLineForPath } from "../find-hunk-line.js";

// ---------------------------------------------------------------------------
// Fixture diffs
// ---------------------------------------------------------------------------

const DIFF_WITH_PATH = `diff --git a/src/added-but-missing.ts b/src/added-but-missing.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/added-but-missing.ts
@@ -0,0 +1,5 @@
+export const foo = "bar";
+export const baz = 42;
+
+export function greet(name: string): string {
+  return \`Hello, \${name}\`;
+}
`;

const DIFF_WITHOUT_PATH = `diff --git a/README.md b/README.md
index 0000000..e69de29
--- /dev/null
+++ b/README.md
@@ -0,0 +1,3 @@
+# My Project
+
+Welcome.
`;

const MULTI_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+export const added = true;
 export const foo = "bar";
diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,2 +12,3 @@
+export const second = true;
 export const other = "value";
`;

const RENAME_DIFF = `diff --git a/old-path.ts b/new-path.ts
similarity index 100%
rename from old-path.ts
rename to new-path.ts
--- a/old-path.ts
+++ b/new-path.ts
@@ -1,1 +2,1 @@
+// renamed
 // original
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findHunkLineForPath", () => {
  it("diff contains the path in +++ b/<path> — returns hunk newStart", () => {
    const result = findHunkLineForPath(DIFF_WITH_PATH, "src/added-but-missing.ts");
    // @@ -0,0 +1,5 @@ → newStart is 1
    expect(result).toBe(1);
  });

  it("diff contains the path with +++ a/<path> (rename source) — returns hunk newStart", () => {
    const result = findHunkLineForPath(RENAME_DIFF, "new-path.ts");
    // @@ -1,1 +2,1 @@ → newStart is 2
    expect(result).toBe(2);
  });

  it("diff does NOT contain the path — returns null", () => {
    const result = findHunkLineForPath(DIFF_WITHOUT_PATH, "src/added-but-missing.ts");
    expect(result).toBeNull();
  });

  it("diff contains the path multiple times — returns FIRST occurrence hunk line", () => {
    const result = findHunkLineForPath(MULTI_FILE_DIFF, "src/foo.ts");
    // First @@ is @@ -1,3 +1,4 @@ → newStart 1
    expect(result).toBe(1);
  });

  it("completely empty diff — returns null", () => {
    expect(findHunkLineForPath("", "src/anything.ts")).toBeNull();
  });

  it("path is a prefix of another path — exact match only", () => {
    // src/foo should NOT match src/foobar.ts
    const diff = `--- /dev/null\n+++ b/src/foobar.ts\n@@ -0,0 +5,1 @@\n+x`;
    expect(findHunkLineForPath(diff, "src/foo")).toBeNull();
  });
});
