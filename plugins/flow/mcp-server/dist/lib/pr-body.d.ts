/**
 * Pure utility functions for composing branch slugs, commit bodies,
 * commit subjects, and PR bodies for the dev subagent's terminal action.
 *
 * @see _bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract
 *
 * All exports are pure (no I/O, no side effects). Deterministic output
 * for any given input.
 *
 * (Story 4.4 Task 3.1)
 */
import { CONVENTIONAL_COMMIT_TYPES } from "./git.js";
export { CONVENTIONAL_COMMIT_TYPES };
/**
 * Compose a `story/<ref-slug>-<title-slug>` branch name from the story
 * ref and title, per Pattern §9 (AC1a).
 *
 * Rules:
 * - `ref-slug`: ref lowercased, non-`[a-z0-9-]` chars replaced by `-`,
 *   consecutive hyphens collapsed, leading/trailing hyphens stripped.
 * - `title-slug`: same normalisation applied to title, then trimmed to
 *   40 characters at a char boundary (not breaking a word — just
 *   truncating at exactly 40 chars from the normalised string), then
 *   leading/trailing hyphens stripped from the result.
 * - The title-slug MUST contain at least one alphanumeric character;
 *   if not, throws `BranchSlugUnrenderableError`.
 *
 * @throws {BranchSlugUnrenderableError} When the resulting title slug
 *   has no alphanumeric characters.
 */
export declare function buildBranchSlug(opts: {
    ref: string;
    title: string;
}): string;
/**
 * Hard-wrap a commit body string at `width` characters (default 72).
 *
 * Rules (AC1d / Implementation strategy):
 * - Split on `\n` to process each line independently.
 * - Lines containing `http://` or `https://` are left untouched (URLs
 *   must not be broken).
 * - Lines ≤ `width` chars are passed through unchanged.
 * - Lines > `width` chars are wrapped at the nearest preceding space
 *   boundary at or before `width`. If no space is found, the line is
 *   left as-is (no break on un-breakable content).
 *
 * The output is joined back with `\n`.
 */
export declare function wrapCommitBody(body: string, width?: number): string;
/**
 * Compose a conventional-commits subject line `<type>(<shortHandle>): <title>`.
 * The scope is the human-friendly short handle derived from the story ref via
 * `shortHandle()`, so operator-visible surfaces (PR title, commit log) show a
 * concise identifier instead of the full 26-character ULID.
 *
 * **Full-ref preservation (AC2):** the full story ref is NOT lost — it is written
 * verbatim into the PR body's machine block by `composePrBody` via the `Story:`
 * line. `runDevTerminalAction` passes the unshortened `ref` to `composePrBody`
 * directly (see `run-dev-terminal-action.ts` lines ~257–262), so no correlation
 * information is dropped by shortening the scope here.
 *
 * **Reviewer correlation (AC1, AC2):** `runReviewerSession` correlates stories
 * via the `ref` parameter passed directly to `runReviewerSession` — it does NOT
 * parse the ref from the commit subject or PR title. Shortening the scope here is
 * therefore safe: the reviewer's correlation path is unaffected.
 *
 * **Safe fallback (AC3):** `shortHandle()` returns the full input string unchanged
 * when the ref contains no colon separator (unrecognised shape). In that case this
 * function emits the full ref as the scope, so the subject is never left without a
 * usable story identifier. No extra guard is required here.
 */
export declare function composeCommitSubject(opts: {
    type: string;
    ref: string;
    title: string;
}): string;
/**
 * Compose the two-section PR body per AC1g:
 *
 * **Section 1 (machine block):**
 * ```
 * <!-- flow:pr:machine -->
 * Story: <ref>
 * Spec: <specPath>
 * ACs:
 * - [ ] AC1: <first line, truncated to 120 chars>
 * ...
 * <!-- /flow:pr:machine -->
 * ```
 *
 * **Section 2 (free-form summary):**
 * The caller's `summary` string verbatim (no wrap applied).
 *
 * The two sections are separated by a single blank line.
 */
export declare function composePrBody(opts: {
    ref: string;
    specPath: string;
    acs: Array<{
        index: number;
        firstLine: string;
    }>;
    summary: string;
}): string;
