/**
 * Extract acceptance-criteria entries from a story spec file.
 *
 * @see _bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract
 *
 * (Story 4.4 Task 3.2)
 */
import { promises as fs } from "node:fs";
/**
 * Read the spec file at `specPath`, extract every AC heading that matches
 * the pattern `**AC<N>...:` (where `N` is one or more digits), and return
 * an array of `{ index, firstLine }` objects in numeric order.
 *
 * The regex matches (byte-identical to the BMad adapter, Story 8.2):
 *   `**AC1:**`, `**AC2 (user-surface):**`, `**AC3 — descriptive title:**`
 *
 * The `firstLine` is the first non-blank line of the AC's body (the text
 * that follows the `**ACN...**` heading line), truncated to 120 characters.
 *
 * Lines that are themselves AC headings are NOT included as firstLine
 * candidates — only the narrative body lines below the heading.
 */
export async function extractAcsFromSpec(specPath) {
    const raw = await fs.readFile(specPath, "utf8");
    const lines = raw.split("\n");
    // Regex to identify an AC heading line. Kept BYTE-IDENTICAL to the BMad
    // adapter's heading regex (`parse-bmad-story.ts`) so the reviewer extracts
    // the SAME ACs the scanner parsed — closing the "reviewer verifies zero ACs
    // on em-dash headings" divergence (Story 8.2). Matches:
    //   **AC1:**  **AC2 (user-surface):**  **AC3 — descriptive title:**  **AC4 — title (integration):**
    const AC_HEADING_RE = /^\*\*AC(\d+)(?:\s+—\s+[^()]*?)?(?:\s*\(([^)]+)\))?:\*\*\s*$/;
    const results = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = AC_HEADING_RE.exec(line);
        if (!headingMatch)
            continue;
        const index = parseInt(headingMatch[1], 10);
        // Extract the parenthetical tag from the AC heading (Story 4.6 Task 1.2).
        // headingMatch[2] is the tag content WITHOUT parens (e.g. "user-surface"),
        // captured by `\(([^)]+)\)` — matching the BMad parser's group (Story 8.2).
        const tag = headingMatch[2] ? headingMatch[2].trim() : null;
        // Collect all body lines after the heading (Story 4.6 Task 1.3).
        // Body runs until the next AC heading, the next level-2 section heading
        // (## ), or end of file. Stopping at ## prevents prose under sections like
        // "## Implementation Notes" from being picked up as AC body (M2 fix).
        const body = [];
        let firstLine = "";
        for (let j = i + 1; j < lines.length; j++) {
            const candidate = lines[j];
            // Stop if we hit another AC heading.
            if (AC_HEADING_RE.test(candidate.trim()))
                break;
            // Stop if we hit any level-2 (or higher) markdown section heading.
            if (/^##+ /.test(candidate))
                break;
            body.push(candidate);
            // Find first non-blank line for firstLine (original logic preserved).
            if (firstLine === "" && candidate.trim().length > 0) {
                firstLine = candidate.trim().slice(0, 120);
            }
        }
        results.push({ index, firstLine, tag, body });
    }
    // Sort numerically (specs are usually in order, but be defensive).
    results.sort((a, b) => a.index - b.index);
    return results;
}
