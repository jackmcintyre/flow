/**
 * Pure helper: search a unified diff for a file path match and return the
 * starting line number of the first hunk that owns that file's `+++` header.
 *
 * Used by `postReviewerComments` to locate the inline-comment anchor line for
 * a failing `runnable-artifact-check` AC whose `artifactPath` appears in the
 * PR diff.
 *
 * Story 4.6b Task 4.5 / Task 9
 */

/**
 * Find the `+`-side starting line number of the first hunk that follows a
 * `+++ [ab]/<path>` header matching the supplied `filePath` in the unified diff.
 *
 * Returns the `newStart` integer from the first `@@ -<old>,<n> +<newStart>,<n> @@`
 * line that appears after the matching `+++ b/<path>` (or `+++ a/<path>`) header.
 *
 * Returns `null` if the path is not found in the diff.
 *
 * When the path appears multiple times (multi-hunk diff), returns the FIRST
 * occurrence's hunk line.
 *
 * @param diff - The raw unified diff string returned by `gh pr diff <prNumber>`.
 * @param filePath - The exact artifact path to search for (e.g. `"src/foo.ts"`).
 */
export function findHunkLineForPath(diff: string, filePath: string): number | null {
  const lines = diff.split("\n");

  let foundFile = false;

  for (const line of lines) {
    if (!foundFile) {
      // Match `+++ b/<path>` or `+++ a/<path>` (rename source)
      const headerMatch = /^\+\+\+ [ab]\/(.+)$/.exec(line);
      if (headerMatch && headerMatch[1] === filePath) {
        foundFile = true;
      }
      continue;
    }

    // We found the file header; now look for the first @@ hunk line.
    // A new `+++ ` header for a different file resets the search.
    if (line.startsWith("+++ ")) {
      // Different file — stop looking (path was in the diff but had no hunk?)
      break;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      return parseInt(hunkMatch[1]!, 10);
    }
  }

  return null;
}
