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

const LANG_FILE_MAP: Record<string, string> = {
  "package.json": "TypeScript",
  "tsconfig.json": "TypeScript",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  "Cargo.toml": "Rust",
  "go.mod": "Go",
};

const LANG_EXT_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".md": "Markdown",
};

const MANIFEST_FILENAMES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "build.gradle",
  "pom.xml",
] as const;

/**
 * Guess languages present at the top level of a target repo from its
 * first-level listing. Returns a deduped, case-sensitive sorted list.
 *
 * Heuristic per the story spec — no shell-out, no HTTP.
 */
export function detectLanguagesFromLayout(entries: string[]): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    const direct = LANG_FILE_MAP[entry];
    if (direct) {
      found.add(direct);
      continue;
    }
    const dotIdx = entry.lastIndexOf(".");
    if (dotIdx >= 0) {
      const ext = entry.slice(dotIdx);
      const lang = LANG_EXT_MAP[ext];
      if (lang) found.add(lang);
    }
  }
  return [...found].sort();
}

/**
 * Filter a first-level listing to the canonical dependency-manifest
 * filenames. Returns the sorted intersection.
 */
export function detectDependencyManifests(entries: string[]): string[] {
  const set = new Set(entries);
  return MANIFEST_FILENAMES.filter((name) => set.has(name)).slice().sort();
}

/**
 * Trim trailing whitespace, take the first `max` characters, and
 * append `"…"` only if truncated. Pure.
 */
export function truncateReadmeExcerpt(raw: string, max = 500): string {
  const trimmed = raw.replace(/\s+$/, "");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}
