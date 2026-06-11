import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { DisciplineViolation, DisciplineViolationReason, SourceStory } from "../adapters/adapter.js";
import { resolveDisciplinePaths } from "../validators/discipline-resolvability.js";
import { extractDepRefsFromSpecBody } from "../lib/extract-dep-refs.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { classifyRiskTier } from "./classify-risk-tier.js";
import { classifyStoryLane } from "./classify-story-lane.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import type { ChangeType } from "../schemas/risk-tiering-spec.js";
import {
  ExecutionManifestSchema,
  parseExecutionManifest,
} from "../schemas/execution-manifest.js";
import type { ExecutionManifest } from "../schemas/execution-manifest.js";
import { STATE_NAMES, type StateName } from "../state/manifest-state-machine.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
import {
  renderExpectedWorkCounters,
  type RejectedFile,
} from "../lib/expected-work-counters.js";

/**
 * Result returned by `scanSources`. All five ref arrays are disjoint.
 *
 * - `createdRefs`: manifests that did not exist before this scan (AC1 path).
 * - `updatedRefs`: manifests still in `to-do/` whose `source_hash` was
 *   refreshed because the source story changed (AC3 path).
 * - `unchangedRefs`: manifests in `to-do/` with a matching hash — no write
 *   performed (AC2 idempotent path).
 * - `skippedRefs`: refs the adapter listed but the tool deliberately did NOT
 *   touch. `reason: "not-in-to-do"` means the manifest already exists in
 *   another state dir (in-progress, blocked, done) — the dev loop owns it
 *   there, or a prior scan already blocked it. `reason: "discipline-violation"`
 *   means this scan just created a new blocked manifest for the first time.
 * - `blockedRefs`: refs that failed discipline in THIS scan and had a manifest
 *   written to `blocked/` for the first time (Story 3.5 Task 6.3). Overlaps
 *   with `skippedRefs[reason: "discipline-violation"]` by design — `skippedRefs`
 *   is the legacy seam, `blockedRefs` is the new operator-facing surface. On
 *   the second scan after a story is blocked, it appears in skippedRefs with
 *   `reason: "not-in-to-do"` (blocked manifests are owned state, not touched).
 */
export interface ScanResult {
  targetRepoRoot: string;
  adapterName: string;
  createdRefs: string[];
  updatedRefs: string[];
  unchangedRefs: string[];
  skippedRefs: Array<{
    ref: string;
    reason: "not-in-to-do" | "discipline-violation" | "unreadable-manifest";
    detail?: string;
  }>;
  /** Story 3.5: refs that failed planning-discipline and were written to blocked/. */
  blockedRefs: string[];
  /**
   * Story 5.13: refs blocked because prose dep declarations and the manifest's
   * `depends_on` set are not equal (symmetric difference is non-empty).
   * Each entry carries the symmetric-difference detail for the rendered output.
   */
  depsDriftRefs: Array<{ ref: string; proseRefs: string[]; manifestRefs: string[] }>;
  /**
   * Story native:01KTSR3E7FE61XB2PN8VJ24289: total files the adapter saw in the
   * stories directory on this scan pass (including rejected ones). Zero when the
   * adapter does not support `getListingStats()` (e.g. BMad).
   */
  filesSeenCount: number;
  /**
   * Story native:01KTSR3E7FE61XB2PN8VJ24289: files that were visible to the
   * adapter but could not be used (e.g. bad filename). Empty when the adapter
   * does not support `getListingStats()`.
   */
  filesRejected: RejectedFile[];
}

/**
 * Render a `ScanResult` as a human-readable text summary.
 * The tool returns this string verbatim; the `/flow:scan` skill
 * prints it without paraphrase or omission.
 */
export function renderScanResult(result: ScanResult): string {
  const lines: string[] = [
    `scan-sources completed for ${result.targetRepoRoot}`,
    `adapter: ${result.adapterName}`,
    ``,
    `created:   ${result.createdRefs.length} ref(s)${result.createdRefs.length > 0 ? " — " + result.createdRefs.join(", ") : ""}`,
    `updated:   ${result.updatedRefs.length} ref(s)${result.updatedRefs.length > 0 ? " — " + result.updatedRefs.join(", ") : ""}`,
    `unchanged: ${result.unchangedRefs.length} ref(s)${result.unchangedRefs.length > 0 ? " — " + result.unchangedRefs.join(", ") : ""}`,
  ];

  // Omit discipline-violation refs from the skipped line when they are already
  // named in the blocked line — they're the same refs and printing both causes
  // confusion about whether they're separate problems.
  const blockedRefSet = new Set(result.blockedRefs ?? []);
  const skippedForDisplay = result.skippedRefs.filter(
    (s) => !(s.reason === "discipline-violation" && blockedRefSet.has(s.ref)),
  );
  if (skippedForDisplay.length > 0) {
    lines.push(
      `skipped:   ${skippedForDisplay.length} ref(s) — ` +
        skippedForDisplay
          .map((s) => `${s.ref} (${s.reason}${s.detail ? ": " + s.detail : ""})`)
          .join(", "),
    );
  } else {
    lines.push(`skipped:   0 ref(s)`);
  }

  // Story 5.13: deps-drift lines — emitted BEFORE the blocked summary line so the
  // operator sees the more-actionable signal first (per Implementation Strategy § 3).
  const depsDriftRefs = result.depsDriftRefs ?? [];
  for (const entry of depsDriftRefs) {
    const proseSet = `{${entry.proseRefs.sort().join(", ")}}`;
    const manifestSet = `{${entry.manifestRefs.sort().join(", ")}}`;
    lines.push(`[deps-drift] ${entry.ref} — prose: ${proseSet}, manifest: ${manifestSet}`);
  }

  // Story 3.5 Task 6.3: blocked refs line (operator-facing surface).
  // A blocked ref here is the operator's cue to fix the source story
  // (add an integration AC, declare missing depends_on, etc.) and re-run /flow:scan.
  if ((result.blockedRefs ?? []).length > 0) {
    lines.push(
      `blocked:   ${result.blockedRefs.length} ref(s) — ` +
        result.blockedRefs.join(", ") +
        ` (planning-discipline violation — fix the source story and re-run /flow:scan)`,
    );
  } else {
    lines.push(`blocked:   0 ref(s)`);
  }

  // Story native:01KTSR3E7FE61XB2PN8VJ24289: expected-work counters line.
  // Always emitted (including the all-zero case) so an "all clear" is explicit.
  lines.push(
    renderExpectedWorkCounters({
      filesSeenCount: result.filesSeenCount,
      filesRejected: result.filesRejected,
      refsHeld: [], // scan does not track held refs — that is the claim step's domain
    }),
  );

  return lines.join("\n");
}

/**
 * Check whether a path exists on disk; returns null if not found.
 */
async function statOrNull(absPath: string): Promise<ReturnType<typeof fs.stat> | null> {
  try {
    return await fs.stat(absPath);
  } catch {
    return null;
  }
}

/**
 * Compute the repo-relative path from `rawPath` if it falls strictly inside
 * `targetRepoRoot`; otherwise return the absolute path as-is.
 * Avoids leaking absolute paths into committed manifests.
 */
function repoRelativePath(rawPath: string, targetRepoRoot: string): string {
  const rel = path.relative(targetRepoRoot, rawPath);
  // If `rel` starts with ".." or is absolute, the path escapes the repo root.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return rawPath;
  }
  return rel;
}

/**
 * Run the FULL discipline gate for a story at scan time: the adapter's pure
 * validator (`validateAgainstDiscipline`) PLUS the disk-side Tier-0 checks
 * (`resolveDisciplinePaths` — T0-5 cited-source resolvability, T0-6
 * verification-target resolvability). Story 10.3 wires the disk pass in here so
 * both pure and disk violations land in the SAME `discipline_violations` array
 * on the blocked manifest — the operator sees the full list to fix in one pass.
 *
 * Returns `null` when the story passes both passes, or a `DisciplineViolation`
 * carrying every accumulated reason. The disk pass is a no-op for BMad stories
 * (gated to native/enriched in `resolveDisciplinePaths`), so BMad scanning is
 * untouched (AC1c).
 */
async function runFullDisciplineGate(
  story: SourceStory,
  activeAdapter: { validateAgainstDiscipline(s: SourceStory): SourceStory | DisciplineViolation },
  targetRepoRoot: string,
): Promise<DisciplineViolation | null> {
  const pure = activeAdapter.validateAgainstDiscipline(story);
  const reasons: DisciplineViolationReason[] =
    "kind" in pure && pure.kind === "discipline-violation" ? [...pure.violations] : [];

  // Disk-side T0-5 / T0-6 (native/enriched only). Merge into the same array.
  const diskReasons = await resolveDisciplinePaths(story, targetRepoRoot);
  reasons.push(...diskReasons);

  if (reasons.length === 0) return null;
  return { kind: "discipline-violation", ref: story.ref, violations: reasons };
}

/**
 * Strip keys with `undefined` values from a plain object before YAML
 * stringification. Prevents `implementation_notes: ~` appearing in on-disk
 * YAML when the field is absent in the source story.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Compute the symmetric difference between two sets.
 * Returns `{ onlyInA, onlyInB }` — both empty means no drift.
 */
function symmetricDiff(
  a: Set<string>,
  b: Set<string>,
): { onlyInA: string[]; onlyInB: string[] } {
  const onlyInA = [...a].filter((x) => !b.has(x));
  const onlyInB = [...b].filter((x) => !a.has(x));
  return { onlyInA, onlyInB };
}

/**
 * Check whether prose deps in the spec body drift from `story.depends_on`.
 * Re-reads the raw spec file from `story.raw_path`.
 *
 * Returns `null` when there is no drift (prose and manifest agree).
 * Returns `{ proseRefs, manifestRefs }` when the symmetric difference is non-empty.
 */
async function checkDepsDrift(
  story: SourceStory,
): Promise<{ proseRefs: string[]; manifestRefs: string[] } | null> {
  let body: string;
  try {
    body = await fs.readFile(story.raw_path, "utf8");
  } catch {
    // If the file is unreadable, skip the drift check — don't false-positive block.
    return null;
  }

  const proseSet = extractDepRefsFromSpecBody(body);
  const manifestSet = new Set<string>(story.depends_on);

  const { onlyInA: onlyInProse, onlyInB: onlyInManifest } = symmetricDiff(proseSet, manifestSet);

  if (onlyInProse.length === 0 && onlyInManifest.length === 0) {
    return null;
  }

  // Symmetric difference: proseRefs is everything prose sees; manifestRefs is everything manifest sees.
  return {
    proseRefs: [...proseSet].sort(),
    manifestRefs: [...manifestSet].sort(),
  };
}

/**
 * Write a `blocked/` manifest with `blocked_by: "deps-drift"`.
 */
async function writeDepsDriftBlockedManifest(
  story: SourceStory,
  driftDetail: { proseRefs: string[]; manifestRefs: string[] },
  absBlockedPath: string,
  activeAdapterName: string,
  targetRepoRoot: string,
): Promise<void> {
  const blockedManifestRaw = stripUndefined({
    ref: story.ref,
    status: "blocked" as const,
    adapter: activeAdapterName,
    source_path: repoRelativePath(story.raw_path, targetRepoRoot),
    source_hash: story.source_hash,
    depends_on: story.depends_on,
    acceptance_criteria: story.acceptance_criteria,
    title: story.title,
    narrative: story.narrative,
    narrative_struct: story.narrative_struct,
    tasks: story.tasks,
    cited_sources: story.cited_sources,
    implementation_notes: story.implementation_notes,
    withdrawn: false,
    blocked_by: "deps-drift" as const,
    discipline_violations: [
      {
        code: "deps-drift-prose-vs-manifest",
        field: "depends_on",
        detail: `Prose deps: [${driftDetail.proseRefs.join(", ")}]; Manifest deps: [${driftDetail.manifestRefs.join(", ")}]`,
      },
    ],
  });
  const blockedManifest = ExecutionManifestSchema.parse(blockedManifestRaw);
  const yamlText = yamlStringify(blockedManifest, { lineWidth: 0 });
  await writeManagedFile({
    absPath: absBlockedPath,
    contents: yamlText,
    targetRepoRoot,
    mcpToolContext: { toolName: "scanSources", role: "operator" },
  });
}

/**
 * The author-time risk fields stamped onto a fresh `to-do/` manifest.
 * Empty (`{}`) when the story carries no author-time path signal (BMad/legacy
 * stories with no `cited_sources`) — in that case the manifest stays unstamped
 * and the judge panel falls back to its compute-from-diff behaviour.
 */
type AuthorTimeRiskFields =
  | Record<string, never>
  | {
      risk_tier: "low" | "medium" | "high";
      risk_tier_evidence: {
        matched_rule: string;
        paths: string[];
        change_types: ChangeType[];
        diff_size: number;
      };
      lane: "fast" | "full";
    };

/**
 * Story 10.4 — compute the author-time `risk_tier` / `risk_tier_evidence` for a
 * native draft from its DECLARED paths (`cited_sources`), before any build
 * exists. Runs `classifyRiskTier` in author-time mode:
 *   `{ changedPaths: story.cited_sources, commitMessages: [], diffSize: 0 }`.
 * Path-pattern matching with no diff — the same separable classifier the
 * post-build reviewer stamp uses, just fed the author-time path signal.
 *
 * Story native:01KTKJXP6DWN5YHKVG96DH16V0 — also runs `classifyStoryLane` to
 * compute the `lane` field, applying the author's optional `lane_hint` as
 * downgrade-only (a 'fast' hint is honoured only if the lane classifier
 * independently returns 'fast'; a 'full' hint always wins).
 *
 * Gated to native/enriched stories that DECLARE `cited_sources`. A BMad/legacy
 * story with no `cited_sources` returns `{}` (NOT stamped) — no regression to
 * BMad scanning; the judge panel keeps computing the tier from the diff for it.
 *
 * `cited_sources` (the blast radius the author read) is the best author-time
 * signal for risk: the Considered lens only SELECTS a bar, and the reviewer's
 * post-build stamp later refines the tier from the real diff. See the source
 * story's Edge cases for why this is deliberate and bounded.
 */
async function computeAuthorTimeRiskFields(
  story: SourceStory,
  targetRepoRoot: string,
  pluginRoot: string,
): Promise<AuthorTimeRiskFields> {
  // Gate: only native/enriched stories with declared paths get an author-time
  // tier. No cited_sources (BMad/legacy) → leave risk_tier undefined.
  if (story.cited_sources === undefined || story.cited_sources.length === 0) {
    return {};
  }

  const classification = await classifyRiskTier({
    targetRepoRoot,
    pluginRoot,
    storyId: story.ref,
    changedPaths: story.cited_sources,
    commitMessages: [],
    diffSize: 0,
  });

  // Story native:01KTKJXP6DWN5YHKVG96DH16V0 — compute lane from the risk tier
  // and the declared cited sources. Apply the author hint as downgrade-only:
  // the hint is carried in the source story's raw frontmatter via `lane_hint`
  // (if the native adapter exposes it) or is simply absent.
  const laneHint = (story.raw_frontmatter as Record<string, unknown> | undefined)
    ?.lane_hint as "fast" | "full" | undefined;

  const laneResult = classifyStoryLane({
    storyId: story.ref,
    risk_tier: classification.tier,
    cited_sources: story.cited_sources,
    lane_hint: laneHint,
  });

  return {
    risk_tier: classification.tier,
    risk_tier_evidence: {
      matched_rule: classification.matched_rule,
      paths: classification.evidence.paths,
      change_types: classification.evidence.change_types,
      diff_size: classification.evidence.diff_size,
    },
    lane: laneResult.lane,
  };
}

/**
 * Compose a new `ExecutionManifest` object from a `SourceStory`.
 * Validates through the schema defensively — catches coding mistakes in
 * the composer before writing to disk.
 *
 * `riskFields` (Story 10.4) carries the author-time `risk_tier` /
 * `risk_tier_evidence` computed from the story's declared paths; `{}` for
 * BMad/legacy stories with no author-time signal (those manifests stay
 * unstamped — `risk_tier` remains absent).
 */
function composeManifest(
  story: SourceStory,
  adapterName: string,
  targetRepoRoot: string,
  riskFields: AuthorTimeRiskFields = {},
): ExecutionManifest {
  const raw = stripUndefined({
    ref: story.ref,
    status: "to-do" as const,
    adapter: adapterName,
    source_path: repoRelativePath(story.raw_path, targetRepoRoot),
    source_hash: story.source_hash,
    depends_on: story.depends_on,
    acceptance_criteria: story.acceptance_criteria,
    title: story.title,
    narrative: story.narrative,
    // Story 10.2 — additive native-format fields. `undefined` (stripped) for
    // BMad-scanned stories; carried through for native-scanned ones.
    narrative_struct: story.narrative_struct,
    tasks: story.tasks,
    cited_sources: story.cited_sources,
    implementation_notes: story.implementation_notes,
    withdrawn: false,
    // Story 9.1 — the readiness brake. A freshly-scanned item is in to-do/ but
    // NOT claimable until the operator blesses it (markStoryReady / /flow:ready).
    // Written explicitly (not left to the schema default) so the on-disk manifest
    // visibly carries the brake and round-trips stably.
    ready: false,
    // Story 10.4 — author-time risk tier from declared paths (folds in `{}` for
    // BMad/legacy stories, leaving both fields absent after stripUndefined).
    ...riskFields,
  });
  // Defensive parse — throws if the composer produced an invalid shape.
  return ExecutionManifestSchema.parse(raw);
}

/**
 * Project the active adapter's source stories into per-story execution
 * manifests under `<targetRepoRoot>/.flow/state/to-do/<ref>.yaml`.
 *
 * **Idempotency (AC2 / NFR10):** On a re-scan with no source changes, this
 * function writes nothing. "Not rewritten" is load-bearing: the dev loop's
 * polling semantics detect work by mtime changes. Re-writing byte-identical
 * content would produce spurious mtime updates and corrupt the polling.
 *
 * **Hash-refresh (AC3):** If a source story's hash changed AND its manifest
 * is still in `to-do/`, the manifest is rewritten with the new hash and
 * updated `source_path`. All other fields (including any operator hand-edits
 * to `narrative`, `acceptance_criteria`, or `withdrawn`) are preserved.
 *
 * **Claim isolation (AC3 negative):** Manifests in `in-progress/`, `blocked/`,
 * or `done/` are NEVER touched. They are owned by the dev loop / orchestrator.
 * `scan-sources` only ever writes into `to-do/`.
 *
 * **Concurrency:** v1 assumes at most one `scan-sources` invocation per
 * target repo at a time. The MCP server is single-process; concurrent
 * invocations are out of scope. Do NOT add a lock here — see Story 4.x's
 * claim flow for the locking design.
 *
 * **`validateAgainstDiscipline` seam:** The call at step 3 is a documented
 * seam for Story 3.5. In v1, every adapter's implementation is pass-through
 * (returns the input story unchanged). Story 3.5 will make some adapters
 * return a `DisciplineViolation` — at that point the `skippedRefs` path
 * with `reason: "discipline-violation"` will light up without any change to
 * this file.
 */
export async function scanSources(opts: {
  targetRepoRoot: string;
  /**
   * Plugin root override — test seam for the author-time risk classifier's
   * spec lookup (Story 10.4). Defaults to the resolved plugin root.
   */
  pluginRootOverride?: string;
}): Promise<ScanResult> {
  // Step 1: Resolve the workspace. Throws on misconfiguration.
  const workspace = await resolveWorkspace({ targetRepoRoot: opts.targetRepoRoot });
  const { activeAdapter, activeAdapterName, targetRepoRoot } = workspace;

  // Story 10.4 — plugin root for the author-time risk classifier's spec lookup.
  const pluginRoot = opts.pluginRootOverride ?? getPluginRoot();

  // Step 2: List source stories from the active adapter.
  const sourceStories = await activeAdapter.listSourceStories();

  // Story native:01KTSR3E7FE61XB2PN8VJ24289: collect file-level listing stats
  // from adapters that support the optional seam. BMad/unknown adapters without
  // getListingStats() get zeros — the summary still emits the all-zero line so
  // the format is consistent across adapter types.
  const listingStats = activeAdapter.getListingStats?.() ?? {
    filesSeenCount: 0,
    filesRejected: [],
  };

  const result: ScanResult = {
    targetRepoRoot,
    adapterName: activeAdapterName,
    createdRefs: [],
    updatedRefs: [],
    unchangedRefs: [],
    skippedRefs: [],
    blockedRefs: [],
    depsDriftRefs: [],
    filesSeenCount: listingStats.filesSeenCount,
    filesRejected: listingStats.filesRejected,
  };

  const stateRoot = path.join(targetRepoRoot, ".flow", "state");

  // Startup guard: resolve any refs that appear in both to-do/ and blocked/
  // simultaneously. This can occur if a previous blocked→to-do promotion wrote
  // the to-do manifest successfully but the subsequent unlink of the blocked
  // manifest failed (non-atomic write sequence). When both exist, to-do/ wins —
  // delete the stale blocked/ manifest and log a warning so the operator is
  // aware of the recovery. This guard prevents the inconsistency from persisting
  // across subsequent scans.
  {
    const toDoDir = path.join(stateRoot, "to-do");
    const blockedDir = path.join(stateRoot, "blocked");
    let toDoFiles: string[] = [];
    let blockedFiles: string[] = [];
    try {
      toDoFiles = await fs.readdir(toDoDir);
    } catch {
      // Directory may not exist yet on a fresh repo — not an error.
    }
    try {
      blockedFiles = await fs.readdir(blockedDir);
    } catch {
      // Directory may not exist yet on a fresh repo — not an error.
    }
    const toDoRefs = new Set(toDoFiles.filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)));
    for (const blockedFile of blockedFiles) {
      if (!blockedFile.endsWith(".yaml")) continue;
      const ref = blockedFile.slice(0, -5);
      if (toDoRefs.has(ref)) {
        console.warn(
          `[scanSources] Ref ${ref} exists in both to-do/ and blocked/ — recovering by removing stale blocked/ manifest (to-do/ wins).`,
        );
        await fs.unlink(path.join(blockedDir, blockedFile));
      }
    }
  }

  // Step 3 + 4 + 5: For each story, check presence map, validate discipline,
  // then branch on create/blocked-create/update/unchanged/skip.
  //
  // IMPORTANT: The presence check happens FIRST (before discipline). This
  // preserves the "scan does not touch claimed work" invariant for ALL state
  // dirs including `blocked/`. A story already in blocked/ (from a prior scan)
  // is treated as claimed and skipped with reason "not-in-to-do", exactly like
  // stories in in-progress/ or done/. Only if no manifest exists anywhere does
  // the discipline check run and potentially write to blocked/.
  for (const story of sourceStories) {
    // Step 3: Check which state dir this ref's manifest lives in, if any.
    let currentState: StateName | null = null;
    for (const stateName of STATE_NAMES) {
      const absPath = path.join(stateRoot, stateName, `${story.ref}.yaml`);
      const s = await statOrNull(absPath);
      if (s !== null) {
        currentState = stateName;
        break;
      }
    }

    // Step 4: Handle manifests that exist outside to-do/.
    //
    // - in-progress/ or done/: the dev loop owns it — skip unconditionally.
    // - blocked/: re-run the discipline validator. If the source story has been
    //   fixed (validator now passes), promote to to-do/ and delete the blocked
    //   manifest. If it still fails, rewrite the blocked manifest to record the
    //   latest source_hash and updated violations. This is the remediation flow
    //   described in README-install.md § Planning-discipline enforcement.
    if (currentState === "in-progress" || currentState === "done") {
      result.skippedRefs.push({
        ref: story.ref,
        reason: "not-in-to-do",
      });
      continue;
    }

    if (currentState === "blocked") {
      // Read the existing blocked manifest to check whether the source has changed.
      const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
      const rawBlocked = await fs.readFile(absBlockedPath, "utf8");
      const parsedBlocked = yamlParse(rawBlocked) as Record<string, unknown>;
      const existingBlockedHash = parsedBlocked["source_hash"] as string | undefined;

      if (existingBlockedHash === story.source_hash) {
        // Source unchanged — no need to re-evaluate. Skip quietly.
        result.skippedRefs.push({ ref: story.ref, reason: "not-in-to-do" });
        continue;
      }

      // Source hash changed (operator edited the story).
      // Story 5.13: check deps-drift FIRST (more-actionable signal before discipline).
      const driftDetail = await checkDepsDrift(story);
      if (driftDetail !== null) {
        // Still drifting (or now drifting for the first time) — rewrite blocked manifest.
        await writeDepsDriftBlockedManifest(
          story,
          driftDetail,
          absBlockedPath,
          activeAdapterName,
          targetRepoRoot,
        );
        result.skippedRefs.push({
          ref: story.ref,
          reason: "discipline-violation",
          detail: `deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]`,
        });
        result.blockedRefs.push(story.ref);
        result.depsDriftRefs.push({
          ref: story.ref,
          proseRefs: driftDetail.proseRefs,
          manifestRefs: driftDetail.manifestRefs,
        });
        continue;
      }

      // No deps-drift — re-run the FULL discipline gate (pure + disk T0-5/T0-6).
      const disciplineResult = await runFullDisciplineGate(story, activeAdapter, targetRepoRoot);
      if (disciplineResult === null) {
        // Story now passes both deps-drift and discipline — promote from blocked/ to to-do/.
        // NOTE: This sequence is non-atomic: the to-do/ manifest is written
        // first, then the blocked/ manifest is deleted. If the unlink fails
        // (e.g. a mid-flight crash or permission error), both manifests will
        // exist simultaneously. The startup guard above detects and recovers
        // this state on the next scan (to-do/ wins, blocked/ is deleted).
        const absToDoPathNew = path.join(stateRoot, "to-do", `${story.ref}.yaml`);
        const riskFields = await computeAuthorTimeRiskFields(story, targetRepoRoot, pluginRoot);
        const manifest = composeManifest(story, activeAdapterName, targetRepoRoot, riskFields);
        const yamlText = yamlStringify(manifest, { lineWidth: 0 });
        await writeManagedFile({
          absPath: absToDoPathNew,
          contents: yamlText,
          targetRepoRoot,
          mcpToolContext: { toolName: "scanSources", role: "operator" },
        });
        await fs.unlink(absBlockedPath);
        result.createdRefs.push(story.ref);
      } else {
        // Still failing discipline — rewrite the blocked manifest with updated hash and violations.
        const blockedManifestRaw = stripUndefined({
          ref: story.ref,
          status: "blocked" as const,
          adapter: activeAdapterName,
          source_path: repoRelativePath(story.raw_path, targetRepoRoot),
          source_hash: story.source_hash,
          depends_on: story.depends_on,
          acceptance_criteria: story.acceptance_criteria,
          title: story.title,
          narrative: story.narrative,
          narrative_struct: story.narrative_struct,
          tasks: story.tasks,
          cited_sources: story.cited_sources,
          implementation_notes: story.implementation_notes,
          withdrawn: false,
          blocked_by: "planning-discipline" as const,
          discipline_violations: disciplineResult.violations.map((v) => ({
            code: v.code,
            field: v.field,
            detail: v.detail,
          })),
        });
        const blockedManifest = ExecutionManifestSchema.parse(blockedManifestRaw);
        const yamlText = yamlStringify(blockedManifest, { lineWidth: 0 });
        await writeManagedFile({
          absPath: absBlockedPath,
          contents: yamlText,
          targetRepoRoot,
          mcpToolContext: { toolName: "scanSources", role: "operator" },
        });
        const firstViolation = disciplineResult.violations[0];
        result.skippedRefs.push({
          ref: story.ref,
          reason: "discipline-violation",
          detail: firstViolation?.detail,
        });
        result.blockedRefs.push(story.ref);
      }
      continue;
    }

    // Step 5: deps-drift gate (Story 5.13 — new, runs BEFORE discipline for more-actionable signal).
    // Then validateAgainstDiscipline (Story 3.5 — real enforcement).
    // Only runs when no manifest exists anywhere (currentState === null) or
    // when the manifest is already in to-do/ (currentState === "to-do").
    // For the to-do case, both gates are no-ops (the story already passed at first scan).
    if (currentState === null) {
      // Story 5.13: deps-drift gate — runs before discipline so operator sees the
      // more-actionable signal first (a drift is a planner-author mistake).
      const driftDetail = await checkDepsDrift(story);
      if (driftDetail !== null) {
        const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
        await writeDepsDriftBlockedManifest(
          story,
          driftDetail,
          absBlockedPath,
          activeAdapterName,
          targetRepoRoot,
        );
        result.skippedRefs.push({
          ref: story.ref,
          reason: "discipline-violation",
          detail: `deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]`,
        });
        result.blockedRefs.push(story.ref);
        result.depsDriftRefs.push({
          ref: story.ref,
          proseRefs: driftDetail.proseRefs,
          manifestRefs: driftDetail.manifestRefs,
        });
        continue;
      }

      const disciplineResult = await runFullDisciplineGate(story, activeAdapter, targetRepoRoot);
      if (disciplineResult !== null) {
        const firstViolation = disciplineResult.violations[0];
        result.skippedRefs.push({
          ref: story.ref,
          reason: "discipline-violation",
          detail: firstViolation?.detail,
        });

        // Write a blocked manifest into blocked/ (Task 6.1).
        const blockedManifestRaw = stripUndefined({
          ref: story.ref,
          status: "blocked" as const,
          adapter: activeAdapterName,
          source_path: repoRelativePath(story.raw_path, targetRepoRoot),
          source_hash: story.source_hash,
          depends_on: story.depends_on,
          acceptance_criteria: story.acceptance_criteria,
          title: story.title,
          narrative: story.narrative,
          narrative_struct: story.narrative_struct,
          tasks: story.tasks,
          cited_sources: story.cited_sources,
          implementation_notes: story.implementation_notes,
          withdrawn: false,
          blocked_by: "planning-discipline" as const,
          discipline_violations: disciplineResult.violations.map((v) => ({
            code: v.code,
            field: v.field,
            detail: v.detail,
          })),
        });
        const blockedManifest = ExecutionManifestSchema.parse(blockedManifestRaw);
        const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
        const yamlText = yamlStringify(blockedManifest, { lineWidth: 0 });
        await writeManagedFile({
          absPath: absBlockedPath,
          contents: yamlText,
          targetRepoRoot,
          mcpToolContext: { toolName: "scanSources", role: "operator" },
        });
        result.blockedRefs.push(story.ref);
        continue;
      }
    }

    // Step 6: Branch on to-do presence.
    const absToDoPath = path.join(stateRoot, "to-do", `${story.ref}.yaml`);

    if (currentState === null) {
      // CREATE path (AC1): no manifest exists anywhere and discipline passed.
      const riskFields = await computeAuthorTimeRiskFields(story, targetRepoRoot, pluginRoot);
      const manifest = composeManifest(story, activeAdapterName, targetRepoRoot, riskFields);
      const yamlText = yamlStringify(manifest, { lineWidth: 0 });
      await writeManagedFile({
        absPath: absToDoPath,
        contents: yamlText,
        targetRepoRoot,
        mcpToolContext: { toolName: "scanSources", role: "operator" },
      });
      result.createdRefs.push(story.ref);
    } else if (currentState === "to-do") {
      // UPDATE or UNCHANGED path (AC2/AC3): manifest is in to-do/.
      // Story 5.19: wrap readFile in try/catch — on read failure (corrupt FS,
      // permissions, transient IO), skip this single manifest with
      // reason: "unreadable-manifest" and detail: "<errno>: <path>" so the
      // scan continues with the remaining manifests instead of aborting.
      let rawText: string;
      try {
        rawText = await fs.readFile(absToDoPath, "utf8");
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
        result.skippedRefs.push({
          ref: story.ref,
          reason: "unreadable-manifest",
          detail: `${errno}: ${absToDoPath}`,
        });
        continue;
      }
      let existingManifest: ExecutionManifest;
      try {
        const parsed = yamlParse(rawText) as unknown;
        existingManifest = parseExecutionManifest(parsed, { absPath: absToDoPath });
      } catch (err) {
        // Story 5.19: malformed YAML / schema parse failures are per-file
        // recoverable signals — push to skippedRefs with reason: "unreadable-manifest"
        // and detail derived from the error, then continue. (Previously this
        // path propagated MalformedExecutionManifestError to the boundary,
        // aborting the entire scan on the first bad file.)
        const detailMessage =
          err instanceof Error ? err.message : String(err);
        result.skippedRefs.push({
          ref: story.ref,
          reason: "unreadable-manifest",
          detail: `parse-error: ${detailMessage}`,
        });
        continue;
      }

      if (existingManifest.source_hash !== story.source_hash) {
        // Story 5.16: deps-drift gate on to-do refresh — mirrors blocked-branch (line 404)
        // and currentState === null (line 496). Without this, an operator edit that
        // introduces a new prose dep AFTER first scan would silently absorb into the
        // refreshed to-do manifest.
        const driftDetail = await checkDepsDrift(story);
        if (driftDetail !== null) {
          const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
          await writeDepsDriftBlockedManifest(
            story,
            driftDetail,
            absBlockedPath,
            activeAdapterName,
            targetRepoRoot,
          );
          // Remove the to-do/ copy now that the blocked/ copy exists (finding M3).
          // Without this the story lives in BOTH states at once and the to-do copy
          // stays claimable — a story that drifted into blocked could still build.
          // Mirrors the promotion path's write-then-unlink (line ~600); non-atomic
          // by the same contract, the startup guard recovers a stranded pair.
          await fs.unlink(absToDoPath);
          result.skippedRefs.push({
            ref: story.ref,
            reason: "discipline-violation",
            detail: `deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]`,
          });
          result.blockedRefs.push(story.ref);
          result.depsDriftRefs.push({
            ref: story.ref,
            proseRefs: driftDetail.proseRefs,
            manifestRefs: driftDetail.manifestRefs,
          });
          continue;
        }

        // No drift — existing rewrite path follows unchanged.
        // Hash changed → rewrite with new hash and source_path; preserve all other fields.
        // Operator hand-edits to narrative, acceptance_criteria, withdrawn etc. are preserved
        // per Story 3.7's hand-edit allowance.
        const updatedManifest = {
          ...existingManifest,
          source_hash: story.source_hash,
          source_path: repoRelativePath(story.raw_path, targetRepoRoot),
        };
        const yamlText = yamlStringify(stripUndefined(updatedManifest as Record<string, unknown>), {
          lineWidth: 0,
        });
        await writeManagedFile({
          absPath: absToDoPath,
          contents: yamlText,
          targetRepoRoot,
          mcpToolContext: { toolName: "scanSources", role: "operator" },
        });
        result.updatedRefs.push(story.ref);
      } else {
        // Hash matches → no-op (AC2 idempotency).
        result.unchangedRefs.push(story.ref);
      }
    }
    // Note: the else branch for currentState not null and not "to-do" is handled
    // in Step 4 above (before discipline check) — those refs are already skipped.
  }

  return result;
}
