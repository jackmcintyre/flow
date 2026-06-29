/**
 * Derive a per-AC verification marker for a BMad acceptance criterion from the
 * story's own signals — Story native:01KW5W081X3TJPQBCYF3WAK9RZ.
 *
 * BMad source stories do NOT carry the inline `vitest:`/`artifact:` markers the
 * native author/parse path requires, so every BMad AC the reviewer sees is
 * classified `manual-check-required` — which deterministically blocks the
 * verdict and stalls `/flow:run` on a marker-only gap (recurred 5x across Epic 1).
 *
 * This helper closes that gap WITHOUT the operator hand-editing gitignored source
 * files: it mines a candidate verification target from the AC's own prose plus the
 * story's implementation notes, and emits a marker ONLY when that target resolves
 * on the tree it is given (`exists`). When nothing real can be derived it returns
 * `undefined` and the caller falls back to manual verification — it NEVER fabricates
 * a path. That resolvability guard is the whole point: a fabricated `vitest:`/
 * `artifact:` target would turn a benign marker gap into a hard non-runnable-target
 * failure (the mirror of #422), making the stall worse, not better.
 *
 * The function is pure given its `exists` resolver — it performs no I/O itself, so
 * the same logic runs at scan time (resolving against the dev working tree) and at
 * review time (resolving against the PR-branch worktree the checks actually run in).
 */

/**
 * Match a repo-relative test-file path anywhere in a blob of prose. Restricted to
 * the runnable test conventions (`*.test.ts(x)` / `*.spec.ts(x)`), so a derived
 * `vitest:` target is structurally guaranteed to be a runnable test and never an
 * ordinary source file (the `non-runnable-test-target` flaw). The leading
 * backtick / quote a story may wrap the path in is excluded from the character
 * class, so it is naturally trimmed.
 */
const TEST_FILE_RE = /([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:test|spec)\.tsx?)/g;

export interface DeriveBmadAcVerificationArgs {
  /** The AC's resolved kind (`integration` ACs additionally consider the artifact convention). */
  kind: "integration" | "unit";
  /** The AC's Given/When/Then prose (one of the mining sources for a test reference). */
  acBodyText: string;
  /** The story's `## Dev Notes` / `## Implementation Notes` body, if any (the other mining source). */
  implementationNotes: string | undefined;
  /** Epic number from the story filename (`<epic>-<story>-<slug>.md`). */
  epic: string;
  /** Story number from the story filename. */
  story: string;
  /** Slug from the story filename. */
  slug: string;
  /**
   * Resolver: does `relPath` (repo-relative) exist on the tree being checked?
   * Scan time passes the dev working tree; review time passes the PR worktree.
   */
  exists: (relPath: string) => boolean;
}

/**
 * Normalise a mined path token: trim surrounding whitespace, backticks, quotes,
 * and a leading `./` so it resolves cleanly against a repo root.
 */
function normaliseCandidate(raw: string): string {
  return raw.trim().replace(/^[`'"]+|[`'"]+$/g, "").replace(/^\.\//, "");
}

/**
 * Collect distinct test-file path candidates from a single blob of prose, in
 * first-seen order.
 */
function collectTestFileCandidates(blob: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of blob.matchAll(TEST_FILE_RE)) {
    const candidate = normaliseCandidate(m[1]!);
    if (candidate.length === 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** First test-file candidate in `blob` that resolves on disk, or `undefined`. */
function firstResolvableTest(blob: string, exists: (relPath: string) => boolean): string | undefined {
  for (const candidate of collectTestFileCandidates(blob)) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Derive a verification marker for one BMad AC, or `undefined` to fall back to
 * manual verification.
 *
 * Resolution order (first resolvable signal wins). The two AC kinds borrow
 * DIFFERENT story-global fallbacks on purpose, because the implementation notes
 * are not attributable to a specific AC — spraying one notes-test across every AC
 * (including integration ones the artifact convention covers) would misattribute
 * the check:
 *  1. A `*.test.ts(x)` / `*.spec.ts(x)` path cited in the AC's OWN prose →
 *     `{ type: "vitest", target }`. This is the precise, per-AC signal, preferred
 *     for either kind.
 *  2. `integration` ACs → the implementation-artifact path convention
 *     `_bmad-output/implementation-artifacts/<epic>-<story>-<slug>.md` →
 *     `{ type: "artifact", target }`.
 *  3. `unit` ACs → a test-file path cited in the story's implementation notes →
 *     `{ type: "vitest", target }` (the task's "test references found in
 *     implementation notes for unit ACs").
 *
 * Every candidate is gated through `exists`; if none resolve, returns `undefined`.
 */
export function deriveBmadAcVerification(
  args: DeriveBmadAcVerificationArgs,
): { type: "vitest" | "artifact"; target: string } | undefined {
  const { kind, acBodyText, implementationNotes, epic, story, slug, exists } = args;

  // 1. A test cited in the AC's OWN prose (precise, per-AC) — preferred either kind.
  const ownTest = firstResolvableTest(acBodyText, exists);
  if (ownTest) {
    return { type: "vitest", target: ownTest };
  }

  // 2. Integration ACs: the implementation-artifact doc convention (artifact).
  if (kind === "integration") {
    const artifactTarget = `_bmad-output/implementation-artifacts/${epic}-${story}-${slug}.md`;
    if (exists(artifactTarget)) {
      return { type: "artifact", target: artifactTarget };
    }
    return undefined;
  }

  // 3. Unit ACs: a test referenced in the story's implementation notes.
  const notesTest = firstResolvableTest(implementationNotes ?? "", exists);
  if (notesTest) {
    return { type: "vitest", target: notesTest };
  }

  // Nothing real could be derived — caller falls back to manual verification.
  return undefined;
}
