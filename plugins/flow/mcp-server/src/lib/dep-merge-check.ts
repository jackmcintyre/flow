/**
 * Dependency-merge check — the build-blind fix.
 *
 * A story is moved to `done/` the moment its PR is *approved* (the reviewer
 * verdict `READY FOR MERGE` → `completeStory`), which happens BEFORE the
 * auto-merge gate runs and well before a medium/high-risk PR is actually
 * merged by a human. The dependency-readiness check in `listClaimableTodos`
 * historically only asked "is the dependency's manifest in `done/`?" — so a
 * dependent story became claimable as soon as its prerequisite was *approved*,
 * and its dev worktree was cut from `origin/main` (which does NOT yet contain
 * the unmerged prerequisite). The dependent was therefore built BLIND to the
 * very change it declared a dependency on.
 *
 * This helper closes that gap: a dependency only counts as satisfied once its
 * PR is genuinely **merged** into the trunk. "Merged" is read from GitHub —
 * the single source of truth that is correct for both auto-merged (low-risk)
 * and human-merged (medium/high-risk) PRs, and is independent of the merge
 * method (squash / rebase / merge-commit all report the PR as MERGED).
 *
 * **Primary probe (Story native:01KTNJ6QVZWVF407QEJPZSDTZK):** when the
 * dependency's `done/` manifest carries a `pr_number` field recorded at
 * PR-open time by `runDevTerminalAction`, we use `gh pr view <prNumber>`
 * to ask whether the PR is merged. This survives title changes and manual
 * ships (where the real branch name differs from the current-title-derived
 * slug). The recorded `pr_number` is the source of truth.
 *
 * **Fallback probe (legacy manifests):** when no `pr_number` is recorded (old
 * manifests pre-dating the field, or stories shipped before this change), we
 * reproduce the head branch from `{ref, title}` via `buildBranchSlug` and ask
 * `gh pr list --head <branch> --state merged` (the original behaviour). This
 * path is retained so legacy done-manifests do not regress.
 *
 * **Fail-safe:** any failure to *prove* a dependency merged — an un-renderable
 * slug, a `gh` error (missing CLI, auth, network), or unparseable output —
 * returns `false`. The conservative direction is "not merged → do not claim",
 * because building a dependent blind is the exact failure this guards against.
 * A transient `gh` outage at worst stalls a chain (the operator notices a
 * dependent that will not claim); it never lets a blind build proceed.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execa as defaultExeca } from "execa";
import { parse as yamlParse } from "yaml";
import { buildBranchSlug } from "./pr-body.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";

/**
 * True iff the dependency's PR is merged into the trunk on GitHub.
 *
 * Primary probe: when `prNumber` is supplied (recorded onto the manifest at
 * PR-open time), uses `gh pr view <prNumber> --json state` to ask whether
 * the PR state is `"MERGED"`. This is correct regardless of the branch name.
 *
 * Fallback probe: when `prNumber` is absent (legacy manifest), reproduces the
 * head branch from `{ref, title}` via `buildBranchSlug` and calls
 * `gh pr list --head <branch> --state merged`.
 *
 * Returns `false` (conservative) on any inability to prove the merge — see the
 * file-level fail-safe note.
 */
export async function isDependencyPrMerged(opts: {
  /** Absolute path to the target repo root — `gh` resolves the repo from this cwd. */
  targetRepoRoot: string;
  /** The dependency's story ref (from its `done/` manifest). */
  ref: string;
  /** The dependency's title (from its `done/` manifest) — needed to reproduce the branch slug. */
  title: string;
  /**
   * The real GitHub PR number recorded on the manifest at PR-open time
   * (Story native:01KTNJ6QVZWVF407QEJPZSDTZK). When present, the primary
   * `gh pr view` probe is used instead of the slug-based fallback.
   */
  prNumber?: number;
  /** Test seam — production callers omit it and the real `execa` is used. */
  execaImpl?: typeof defaultExeca;
}): Promise<boolean> {
  const execaImpl = opts.execaImpl ?? defaultExeca;

  // Primary probe: use the recorded PR number when available.
  if (opts.prNumber !== undefined) {
    try {
      const result = await execaImpl(
        "gh",
        ["pr", "view", String(opts.prNumber), "--json", "state"],
        { cwd: opts.targetRepoRoot },
      );
      const stdout = (result.stdout ?? "").trim();
      if (stdout === "") return false;
      const parsed: unknown = JSON.parse(stdout);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        "state" in parsed &&
        (parsed as { state: unknown }).state === "MERGED"
      );
    } catch {
      // gh missing / auth / network / non-zero exit / unparseable JSON →
      // conservative not-merged (never let a dependent build blind).
      return false;
    }
  }

  // Fallback probe: legacy manifests without pr_number — reproduce the branch slug.
  let branch: string;
  try {
    branch = buildBranchSlug({ ref: opts.ref, title: opts.title });
  } catch {
    // Un-renderable slug → we cannot identify the PR → conservative not-merged.
    return false;
  }

  try {
    const result = await execaImpl(
      "gh",
      ["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--limit", "1"],
      { cwd: opts.targetRepoRoot },
    );
    const stdout = (result.stdout ?? "").trim();
    if (stdout === "") return false;
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // gh missing / auth / network / non-zero exit / unparseable JSON →
    // conservative not-merged (never let a dependent build blind).
    return false;
  }
}

/**
 * Single-dependency merge probe: given a dependency ref already present in
 * `done/`, read its manifest (for the title needed to reproduce the branch
 * slug and the `pr_number` for the primary probe) and ask whether its PR is
 * merged. Injectable via `isMerged` for tests.
 */
export type SingleDependencyMergedCheck = (opts: {
  targetRepoRoot: string;
  ref: string;
  title: string;
  /** Recorded PR number from the manifest — present for stories shipped after
   *  Story native:01KTNJ6QVZWVF407QEJPZSDTZK; absent for legacy manifests. */
  prNumber?: number;
}) => Promise<boolean>;

/**
 * True iff EVERY dependency ref is merged into the trunk.
 *
 * Pre-condition (enforced by the caller, `claimNextStory`): each ref is already
 * known to be in `done/` (it passed the `depsReady` filter). This reads each
 * dep's `done/` manifest to recover the `title` required to reproduce its
 * branch slug, then defers the merge decision to `isMerged` (the real
 * GitHub-backed {@link isDependencyPrMerged} in production).
 *
 * **Fail-safe:** a missing/unreadable/malformed `done/` manifest, or any
 * dependency that is not proven merged, yields `false` — the conservative
 * "do not claim" direction. An empty `deps` list is trivially `true`.
 */
export async function areDependenciesMerged(opts: {
  targetRepoRoot: string;
  deps: readonly string[];
  isMerged?: SingleDependencyMergedCheck;
}): Promise<boolean> {
  const isMerged = opts.isMerged ?? isDependencyPrMerged;
  const doneDir = path.join(opts.targetRepoRoot, ".flow", "state", "done");
  // Memo so a dependency shared across the candidate's list is probed once.
  const seen = new Map<string, boolean>();

  for (const dep of opts.deps) {
    const cached = seen.get(dep);
    if (cached !== undefined) {
      if (!cached) return false;
      continue;
    }

    const depPath = path.join(doneDir, `${dep}.yaml`);
    let raw: string;
    try {
      raw = await fs.readFile(depPath, "utf8");
    } catch {
      // Not in done/ (or unreadable) — cannot be merged. Conservative false.
      seen.set(dep, false);
      return false;
    }

    let title: string;
    let prNumber: number | undefined;
    try {
      const manifest = parseExecutionManifest(yamlParse(raw) as unknown, { absPath: depPath });
      title = manifest.title;
      prNumber = manifest.pr_number;
    } catch {
      // Malformed done manifest — cannot reproduce the branch. Conservative false.
      seen.set(dep, false);
      return false;
    }

    const merged = await isMerged({ targetRepoRoot: opts.targetRepoRoot, ref: dep, title, prNumber });
    seen.set(dep, merged);
    if (!merged) return false;
  }

  return true;
}

/**
 * Overlap-gate variant — "is this cited-source overlap blocker still IN FLIGHT?"
 *
 * The cited-source overlap gate (cited-source-overlap.ts) routes done/ siblings
 * that touch a shared file into a merge check. The DECLARED-dependency check
 * above ({@link areDependenciesMerged}) asks "prove it MERGED, else wait",
 * because a dependent genuinely needs the dependency's code on main. The OVERLAP
 * gate has a weaker, different need: it must only avoid building BLIND against a
 * shared-file change that is NOT YET on main. A blocker whose work is already on
 * main (merged) is harmless — the candidate's worktree, cut from current main,
 * already contains it.
 *
 * So the correct overlap signal is "does this blocker still have an OPEN PR?"
 * (its change is in flight, not yet on main) — NOT "prove it merged". This
 * inverts the fail direction: when we cannot positively identify an OPEN PR, we
 * DO NOT block. That fixes the slug-reproduction false-block — a historical
 * done/ story whose PR merged long ago (and whose title-derived branch slug no
 * longer matches its real, deleted branch) is recognised as settled instead of
 * being treated as un-merged forever.
 *
 * A done/ blocker with NO recorded `pr_number` is treated as settled WITHOUT a
 * GitHub call: `pr_number` is stamped at PR-open time, so a done/ manifest that
 * lacks it predates that recording (legacy / manually-shipped) and its work is
 * therefore already on main — it cannot be an in-flight open PR. Only blockers
 * that DO carry a `pr_number` are probed (`gh pr view <n>`); they block iff the
 * PR is still OPEN. This both fixes the false-block and avoids a fan-out of
 * GitHub calls over dozens of ancient siblings.
 *
 * **Fail direction:** a `gh` error while probing a recorded PR number is
 * conservative-blocking (a transient outage briefly stalls a chain, never a
 * blind build); an unreadable/malformed/absent manifest or a missing
 * `pr_number` is settled (not blocking) — the historical-work direction.
 */
export async function isOverlapBlockerInFlight(opts: {
  targetRepoRoot: string;
  prNumber: number;
  execaImpl?: typeof defaultExeca;
}): Promise<boolean> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  try {
    const result = await execaImpl(
      "gh",
      ["pr", "view", String(opts.prNumber), "--json", "state"],
      { cwd: opts.targetRepoRoot },
    );
    const stdout = (result.stdout ?? "").trim();
    if (stdout === "") return true; // cannot read state → conservative block
    const parsed: unknown = JSON.parse(stdout);
    const state =
      typeof parsed === "object" && parsed !== null && "state" in parsed
        ? (parsed as { state: unknown }).state
        : undefined;
    // In flight (blocks) iff the PR is still OPEN. MERGED → on main (safe);
    // CLOSED → abandoned, will never land (safe).
    return state === "OPEN";
  } catch {
    // gh missing / auth / network / non-zero exit / unparseable → conservative
    // block (transient; never lets a blind build proceed against a live PR).
    return true;
  }
}

/** Injectable single-blocker in-flight probe (the real {@link isOverlapBlockerInFlight} in prod). */
export type OverlapBlockerInFlightCheck = (opts: {
  targetRepoRoot: string;
  prNumber: number;
}) => Promise<boolean>;

/**
 * True iff ANY cited-source overlap blocker is still in flight (an OPEN PR whose
 * change is not yet on main). See {@link isOverlapBlockerInFlight} for the
 * per-blocker semantics and the settled-when-no-`pr_number` rule.
 *
 * Pre-condition (caller `claimNextStory`): every ref is a done/ overlap blocker
 * surfaced by `findOverlapBlockers`. Reads each blocker's done/ manifest for its
 * `pr_number`; blockers without one are settled (historical → already on main).
 */
export async function anyOverlapBlockerInFlight(opts: {
  targetRepoRoot: string;
  blockers: readonly string[];
  isInFlight?: OverlapBlockerInFlightCheck;
}): Promise<boolean> {
  const isInFlight = opts.isInFlight ?? isOverlapBlockerInFlight;
  const doneDir = path.join(opts.targetRepoRoot, ".flow", "state", "done");
  // Memo so a blocker shared across the candidate's overlap set is probed once.
  const seen = new Map<string, boolean>();

  for (const ref of opts.blockers) {
    const cached = seen.get(ref);
    if (cached !== undefined) {
      if (cached) return true;
      continue;
    }

    const depPath = path.join(doneDir, `${ref}.yaml`);
    let raw: string;
    try {
      raw = await fs.readFile(depPath, "utf8");
    } catch {
      // Unreadable done manifest → cannot identify an open PR → settled.
      seen.set(ref, false);
      continue;
    }

    let prNumber: number | undefined;
    try {
      const manifest = parseExecutionManifest(yamlParse(raw) as unknown, {
        absPath: depPath,
      });
      prNumber = manifest.pr_number;
    } catch {
      // Malformed done manifest → cannot identify an open PR → settled.
      seen.set(ref, false);
      continue;
    }

    if (prNumber === undefined) {
      // Legacy / manually-shipped done story (predates pr_number recording): its
      // work is already on main, so it is not an in-flight open PR. Settled
      // without a GitHub call — this is the slug-reproduction false-block fix.
      seen.set(ref, false);
      continue;
    }

    const inFlight = await isInFlight({
      targetRepoRoot: opts.targetRepoRoot,
      prNumber,
    });
    seen.set(ref, inFlight);
    if (inFlight) return true;
  }

  return false;
}
