/**
 * Disk-side Tier-0 discipline checks (Story 10.3 — T0-5 and the disk part of
 * T0-6). These run where `targetRepoRoot` + an fs are available — the scan
 * (`scanSources`) and write (`writeNativeStory`) paths — so they live OUTSIDE
 * the pure `validateStoryAgainstDiscipline` validator (which is I/O-free by
 * contract).
 *
 * Both callers share this one implementation so the write-time gate and the
 * scan-time gate enforce identically. Violations returned here merge into the
 * same `DisciplineViolation.violations[]` array the pure validator produces.
 *
 * Checks (native/enriched stories only — `isEnrichedStory`):
 *   - **T0-5** — `cited_sources` is non-empty (`missing-cited-sources`) and each
 *     path resolves on disk (`unresolvable-cited-source`). Cited sources are
 *     files the author read, so they exist at author/scan time.
 *   - **T0-6** — every `verification.target` is well-formed (reject invented
 *     flags / non-path strings such as `vitest --grep …` →
 *     `invalid-verification-target`), and an `artifact:` target resolves on disk
 *     (`unresolvable-verification-target`). A `vitest:` target is shape-checked
 *     but NOT required to pre-exist: it is the test file the *build* creates, so
 *     requiring it would make every new-test story un-writable/un-scannable
 *     (the chicken-and-egg the story's pre-mortem pins). The `artifact:` vs
 *     `vitest:` resolvability asymmetry is DELIBERATE — artifacts are existing
 *     contracts (must resolve); vitest targets are build outputs (shape only).
 *
 * @see _bmad-output/implementation-artifacts/10-3-complete-tier-0-discipline-validator.md
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DisciplineViolationReason, SourceStory } from "../adapters/adapter.js";
import { isEnrichedStory } from "./planning-discipline.js";

/**
 * Reject an obviously non-path verification target — the part of T0-6 that
 * kills the `vitest --grep …` invented-flag anti-pattern the rubric names. A
 * well-formed target is a single repo-relative path token: no whitespace, no
 * leading dash (a flag), and not an absolute path. This is intentionally
 * conservative — it rejects the invented-flag class without trying to validate
 * that the string is a *good* path; on-disk resolution (below) is the stronger
 * check for `artifact:` targets.
 */
function isWellFormedTarget(target: string): boolean {
  const t = target.trim();
  if (t.length === 0) return false;
  // Contains whitespace → not a single path token (e.g. `vitest --grep "foo"`).
  if (/\s/.test(t)) return false;
  // Leading dash → an invented flag (e.g. `--grep`).
  if (t.startsWith("-")) return false;
  // Absolute path → not repo-relative; targets must be repo-relative paths.
  if (path.isAbsolute(t)) return false;
  return true;
}

/**
 * Determine whether a `vitest:` verification target looks like a runnable test.
 *
 * A target is considered a runnable test when its path follows one of the
 * conventional test-file naming patterns that vitest/Jest recognise:
 *   - filename ends in `.test.ts`, `.test.js`, `.test.tsx`, `.test.jsx`,
 *     `.spec.ts`, `.spec.js`, `.spec.tsx`, `.spec.jsx`; or
 *   - path contains a `__tests__/` directory segment.
 *
 * Any path that passes neither check is treated as an ordinary source file
 * (e.g. `src/tools/write-native-story.ts`) and is rejected: a source-file
 * proof is structurally guaranteed to run zero tests and verify nothing
 * (Story native:01KV6S35N4VF64WZT99SMZSFRJ).
 *
 * The check is intentionally restrictive: false negatives (accepting a
 * non-test source file) cause a doomed build-and-review round; false positives
 * (rejecting an unconventionally named real test) would only block the author
 * from using that file as a proof target. The risk commentary in the story
 * flags this as the highest-risk failure mode and accepts the trade-off.
 */
export function isRunnableTestTarget(target: string): boolean {
  const t = target.trim();
  // Check for __tests__/ directory segment (any OS path separator).
  if (/(?:^|[\\/])__tests__[\\/]/.test(t)) return true;
  // Check for conventional test/spec file extensions.
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(t)) return true;
  return false;
}

/** Check whether a path exists on disk; returns null if not found. */
async function statOrNull(absPath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(absPath);
  } catch {
    return null;
  }
}

/**
 * Run the disk-side Tier-0 checks (T0-5 + the disk part of T0-6) against a
 * native/enriched story. Returns the accumulated violations — an empty array
 * means the story passes the disk checks. A non-enriched story (BMad) returns
 * `[]` unconditionally: the new checks are gated to native/enriched stories
 * until ingest (10.5) + cutover (10.6).
 *
 * Multiple violations accumulate — the function does NOT short-circuit on the
 * first failure, so the author/operator sees the full list to fix in one pass.
 *
 * @param story          The story to check (already-parsed `SourceStory`).
 * @param targetRepoRoot The repo root against which repo-relative paths resolve.
 */
export async function resolveDisciplinePaths(
  story: SourceStory,
  targetRepoRoot: string,
): Promise<DisciplineViolationReason[]> {
  if (!isEnrichedStory(story)) return [];

  const reasons: DisciplineViolationReason[] = [];

  // T0-5 — cited_sources present and each resolves on disk.
  const citedSources = story.cited_sources ?? [];
  if (citedSources.length === 0) {
    reasons.push({
      code: "missing-cited-sources",
      field: "cited_sources",
      detail:
        "Native story cites no sources. Every native story must list ≥1 repo-relative path in '## Cited Sources' (the files the author read to ground the story).",
    });
  } else {
    for (const cited of citedSources) {
      const abs = path.resolve(targetRepoRoot, cited);
      if ((await statOrNull(abs)) === null) {
        reasons.push({
          code: "unresolvable-cited-source",
          field: "cited_sources",
          detail: `Cited source '${cited}' does not resolve on disk (looked at '${abs}'). Cited sources are files the author read — fix the path or remove the citation.`,
        });
      }
    }
  }

  // T0-6 — every verification target is well-formed; `artifact:` targets resolve
  // on disk. `vitest:` targets are shape-checked only (the build creates the
  // test — see module header; this asymmetry is deliberate).
  //
  // Story native:01KV6S35N4VF64WZT99SMZSFRJ — additionally, `vitest:` targets
  // must be runnable tests (recognised by conventional naming). A source-file
  // target passes the shape check but would verify nothing at run time.
  story.acceptance_criteria.forEach((ac, i) => {
    const v = ac.verification;
    // A missing verification block is T0-2 (the pure validator's job); skip here
    // so we don't double-report — this pass only judges targets that exist.
    if (!v) return;
    if (!isWellFormedTarget(v.target)) {
      reasons.push({
        code: "invalid-verification-target",
        field: `acceptance_criteria[${i}].verification.target`,
        detail: `AC${i + 1} verification target '${v.target}' is not a well-formed repo-relative path. Reject invented flags / non-path strings (e.g. 'vitest --grep …'); the target must name a single path (a test file for 'vitest:', an artifact for 'artifact:').`,
      });
      // Do not also runnable-test-check or existence-check a malformed target —
      // the shape error is the actionable signal.
      return;
    }
    // Runnable-test-kind check — `vitest:` proofs only. A well-formed path that
    // points at an ordinary source file rather than a recognised test is refused
    // here so the doomed build-and-review round never starts.
    if (v.type === "vitest" && !isRunnableTestTarget(v.target)) {
      reasons.push({
        code: "non-runnable-test-target",
        field: `acceptance_criteria[${i}].verification.target`,
        detail: `AC${i + 1} verification target '${v.target}' is not a runnable test. A 'vitest:' proof must name a test file (e.g. ending in '.test.ts' / '.spec.ts', or under a '__tests__/' directory). Pointing at an ordinary source file runs zero tests and verifies nothing — rename the target to the test file that covers this AC.`,
      });
    }
  });

  // Existence-check artifact targets (deliberately NOT vitest targets).
  for (let i = 0; i < story.acceptance_criteria.length; i++) {
    const v = story.acceptance_criteria[i]!.verification;
    if (!v) continue;
    if (v.type !== "artifact") continue; // vitest: shape-only, build creates it.
    if (!isWellFormedTarget(v.target)) continue; // already reported above.
    const abs = path.resolve(targetRepoRoot, v.target);
    if ((await statOrNull(abs)) === null) {
      reasons.push({
        code: "unresolvable-verification-target",
        field: `acceptance_criteria[${i}].verification.target`,
        detail: `AC${i + 1} artifact verification target '${v.target}' does not resolve on disk (looked at '${abs}'). An 'artifact:' target is an existing contract and must resolve; only 'vitest:' targets (build outputs) are exempt.`,
      });
    }
  }

  return reasons;
}
