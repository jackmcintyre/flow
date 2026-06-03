/**
 * Pure helpers for `readRepoSignals` (Story 2.4 Task 2). No IO — all
 * three functions are deterministic transforms over their inputs.
 *
 * Language detection is a fixed v1 mapping (no `linguist`, no
 * language-server); it operates on the first-level directory listing
 * only. Specialist signal-driven hiring (Story 2.4 AC3 `add` path) leans
 * on `dependencyManifests` more than `languages`; both are coarse but
 * load-bearing for the proposal's one-sentence justifications.
 */
/**
 * Guess languages present at the top level of a target repo from its
 * first-level listing. Returns a deduped, case-sensitive sorted list.
 *
 * Heuristic per the story spec — no shell-out, no HTTP.
 */
export declare function detectLanguagesFromLayout(entries: string[]): string[];
/**
 * Filter a first-level listing to the canonical dependency-manifest
 * filenames. Returns the sorted intersection.
 */
export declare function detectDependencyManifests(entries: string[]): string[];
/**
 * Trim trailing whitespace, take the first `max` characters, and
 * append `"…"` only if truncated. Pure.
 */
export declare function truncateReadmeExcerpt(raw: string, max?: number): string;
