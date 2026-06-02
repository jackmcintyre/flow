/**
 * Extract acceptance-criteria entries from a story spec file.
 *
 * @see _bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract
 *
 * (Story 4.4 Task 3.2)
 */
export interface AcEntry {
    /** AC number as it appears in the spec (e.g. 1 for AC1, 3 for AC3). */
    index: number;
    /** First non-blank line of the AC body, truncated to 120 chars. */
    firstLine: string;
    /**
     * Parenthetical tag from the AC heading, without parens.
     * E.g. `"user-surface"` for `**AC1 (user-surface):**`, `null` for `**AC2:**`.
     * (Story 4.6 Task 1.2)
     */
    tag: string | null;
    /**
     * All body lines of the AC (from the line after the heading until the next
     * AC heading or end of file). Lines are verbatim — not trimmed.
     * (Story 4.6 Task 1.3 — needed by the applicability classifier)
     */
    body: string[];
}
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
export declare function extractAcsFromSpec(specPath: string): Promise<AcEntry[]>;
