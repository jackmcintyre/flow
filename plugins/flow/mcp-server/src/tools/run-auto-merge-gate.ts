/**
 * `runAutoMergeGate` MCP tool — Story 4.10b.
 *
 * Given a session ULID and PR number on the `done-ready-for-merge` branch:
 *
 *  1. Validates `thresholdOverride` if present.
 *  2. Resolves `threshold_used` from workspace-config `plugin.agreement_threshold` (default 0.8).
 *  3. Reads the `done/<ref>.yaml` manifest to extract `risk_tier`.
 *  4. Calls `computeAgreement({ targetRepoRoot, lastNVerdicts: lastNVerdictsOverride })`.
 *  5. Calls `decideAutoMerge({ risk_tier, agreement_metric, threshold })`.
 *  6. Composes the chat-log line.
 *  7. On `dryRun: true` → returns the decision without any gh shell-out.
 *  8. On `decision === "auto-merge"` → calls `gh pr merge <prNumber> --squash --delete-branch`.
 *  9. On `decision === "pause-needs-human"` → resolves owner/repo via `gh repo view`,
 *     then `gh api POST /repos/<owner>/<repo>/issues/<prNumber>/labels` with `needs-human`.
 * 10. Returns `AutoMergeGateResult`.
 *
 * Six-branch decision table: see `lib/auto-merge-gate.ts` (FR40 / FR41 / FR42).
 * Locked gh shape: `gh pr merge <prNumber> --squash --delete-branch` (v1 hardcoded).
 *
 * Manual-merge authority is preserved by structural omission in SKILL.md: the gate
 * is ONLY called under the `done-ready-for-merge` branch. On NEEDS CHANGES / BLOCKED
 * branches the tool is never called, so `gh pr merge` from the operator's own shell
 * proceeds unmolested.
 *
 * Story 4.10b · FR40 · FR41 · FR42
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { parse as yamlParse } from "yaml";
import { execa as defaultExeca } from "execa";

import { decideAutoMerge } from "../lib/auto-merge-gate.js";
import {
  computeAgreement,
  AgreementMetricResultSchema,
  DEFAULT_AGREEMENT_WINDOW,
} from "./compute-agreement.js";
import type {
  AgreementMetricResult,
  ComputeAgreementOptions,
} from "./compute-agreement.js";
import { readManifest } from "../lib/manifest-io.js";
import { readReviewerResultFile } from "../lib/read-reviewer-result-file.js";
import type { ReviewerResultFileShape } from "../lib/read-reviewer-result-file.js";
import type { ExecutionManifest } from "../schemas/execution-manifest.js";
import { loadRolePermissions } from "../state/load-role-permissions.js";
import type { RolePermissions } from "../schemas/role-permissions.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import { gh } from "../lib/gh.js";
import { AutoMergeGateThresholdInvalidError } from "../errors.js";
import { PluginSettingsSchema } from "../schemas/workspace-config.js";
import type { PluginSettings } from "../schemas/workspace-config.js";

// ---------------------------------------------------------------------------
// Output schema & type
// ---------------------------------------------------------------------------

import type { AutoMergeGateReason } from "../lib/auto-merge-gate.js";

const AutoMergeGateReasonSchema = z.enum([
  "low-risk-met-threshold",
  "low-risk-sub-threshold",
  "low-risk-insufficient-data",
  "low-risk-provisional-trust",
  "medium-risk",
  "high-risk",
  "no-tier-no-signal",
  "ci-not-green",
  "merge-failed",
]);

/**
 * Result schema for `runAutoMergeGate`. `.strict()` at every level to reject
 * unknown fields (AC5q).
 *
 * Exported for downstream consumers (tests, future Epic 6 retro tools).
 *
 * Story 4.10b (AC5c / AC5q).
 */
export const AutoMergeGateResultSchema = z
  .object({
    decision: z.enum(["auto-merge", "pause-needs-human"]),
    reason: AutoMergeGateReasonSchema,
    risk_tier: z.enum(["low", "medium", "high"]).nullable(),
    agreement_metric: AgreementMetricResultSchema.nullable(),
    threshold_used: z.number().min(0).max(1),
    merged: z.boolean(),
    labelsApplied: z.array(z.string()),
    dryRun: z.boolean(),
    prNumber: z.number().int().positive(),
    chatLog: z.array(z.string()),
  })
  .strict();

export type AutoMergeGateResult = z.infer<typeof AutoMergeGateResultSchema>;

// Re-export the reason type for downstream consumers.
export type { AutoMergeGateReason };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunAutoMergeGateOptions {
  targetRepoRoot: string;
  prNumber: number;
  /** Execution-manifest ref, e.g. `"native:01HZTEST00000000000000000"`. */
  ref: string;
  sessionUlid: string;
  /**
   * Test seam: bypasses the workspace-config read entirely.
   * Must satisfy `0 <= n <= 1`, finite, NaN-free; else `AutoMergeGateThresholdInvalidError`.
   */
  thresholdOverride?: number;
  /**
   * Test seam: forwarded as `lastNVerdicts` into `computeAgreement`.
   * Production callers pass `undefined` (defaults to 50).
   */
  lastNVerdictsOverride?: number;
  /** When `true`, skips the gh shell-out. Decision is still computed. */
  dryRun?: boolean;
  /** Test seam for execa. Production callers do not pass this. */
  execaImpl?: typeof defaultExeca;
  /** Test seam: inject a custom `computeAgreement` implementation. */
  computeAgreementImpl?: (opts: ComputeAgreementOptions) => Promise<AgreementMetricResult | null>;
  /** Test seam: inject a custom manifest reader. */
  readManifestImpl?: (absPath: string) => Promise<ExecutionManifest>;
  /** Test seam: inject a custom workspace-config loader. */
  loadWorkspaceConfigImpl?: (targetRepoRoot: string) => Promise<PluginSettings>;
  /**
   * Test seam: bypass the workspace-config read for the provisional-trust flag
   * (Stage-2). Production callers pass `undefined` (resolved from config).
   */
  provisionalTrustOverride?: boolean;
  /** Test seam: inject a custom reviewer-result reader (Stage-2 tier fallback). */
  readReviewerResultImpl?: (
    targetRepoRoot: string,
    sessionUlid: string,
    ref: string,
  ) => Promise<ReviewerResultFileShape | null>;
  /**
   * Test seam: bypass the real CI poll (Stage-2 CI-gating). Production callers
   * omit this; the gate polls GitHub checks. Tests inject the desired outcome.
   */
  ciGateImpl?: (opts: {
    prNumber: number;
    role: string;
    permissions: RolePermissions;
    execaImpl: typeof defaultExeca;
    pluginRoot: string;
  }) => Promise<CiGateState>;
  /** Plugin root override — test seam for loadRolePermissions and gh-error-map. */
  pluginRootOverride?: string;
  /** Role name for gh permission lookup (default: "generalist-dev"). */
  role?: string;
}

// ---------------------------------------------------------------------------
// Internal: workspace config reader
// ---------------------------------------------------------------------------

/**
 * Read and parse `<targetRepoRoot>/.flow/config.yaml`, returning the validated
 * `PluginSettings` (with defaults applied). Falls back to schema defaults when
 * `config.yaml` is absent — same semantics as `resolveWorkspace`.
 *
 * @internal — exposed via `loadWorkspaceConfigImpl` test seam.
 */
export async function loadWorkspaceConfig(targetRepoRoot: string): Promise<PluginSettings> {
  const configPath = path.join(targetRepoRoot, ".flow", "config.yaml");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No config.yaml — return schema defaults (agreement_threshold: 0.8).
      return PluginSettingsSchema.parse({});
    }
    throw err;
  }
  const parsed = yamlParse(raw) as unknown;
  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    !("plugin" in (parsed as Record<string, unknown>))
  ) {
    return PluginSettingsSchema.parse({});
  }
  const pluginBlock = (parsed as Record<string, unknown>)["plugin"];
  return PluginSettingsSchema.parse(pluginBlock ?? {});
}

// ---------------------------------------------------------------------------
// CI gate (Stage-2): never auto-merge a PR whose CI is not green
// ---------------------------------------------------------------------------

/** Outcome of the CI gate poll. */
export type CiGateState = "green" | "failed" | "pending-timeout";

const CI_GATE_TIMEOUT_MS = 300_000; // 5 min — covers the ~90s build with headroom
const CI_GATE_POLL_INTERVAL_MS = 15_000;

// Explicit failure signals.
const CI_FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const CI_FAIL_STATES = new Set(["FAILURE", "ERROR"]);
// Explicit pass signals. SKIPPED/NEUTRAL are legitimate non-failures for a
// completed check (e.g. a conditional job that no-ops), so they count as pass.
const CI_PASS_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Classify a `gh pr view --json statusCheckRollup` array into a coarse state,
 * as an ALLOWLIST — "green" requires every item to be *explicitly passing*.
 * Handles CheckRun items (`status`/`conclusion`) and StatusContext items
 * (`state`).
 *
 * Per item: an explicit failure ⇒ the whole rollup is "failed". A COMPLETED
 * CheckRun with a pass conclusion, or a StatusContext `state: SUCCESS`, is a
 * pass. ANYTHING ELSE — not-yet-complete, a completed check with an
 * unrecognized/absent conclusion, or a sparse/unknown-shape item — is treated
 * as NOT-yet-passing (pending), never silently green. Aggregation: any failure
 * ⇒ "failed"; else all items pass (and ≥1) ⇒ "green"; else ⇒ "pending". An
 * empty rollup is "pending" (checks not registered yet).
 *
 * Conservative by construction: a green verdict cannot arise from an item the
 * classifier does not positively recognize as passing.
 *
 * @internal — exported for unit tests.
 */
export function classifyCiRollup(rollup: Array<Record<string, unknown>>): "green" | "failed" | "pending" {
  if (rollup.length === 0) return "pending";
  let allPass = true;
  for (const item of rollup) {
    const status = typeof item["status"] === "string" ? (item["status"] as string) : undefined;
    const conclusion = typeof item["conclusion"] === "string" ? (item["conclusion"] as string) : undefined;
    const state = typeof item["state"] === "string" ? (item["state"] as string) : undefined;

    // Explicit failure short-circuits the whole rollup.
    if ((conclusion && CI_FAIL_CONCLUSIONS.has(conclusion)) || (state && CI_FAIL_STATES.has(state))) {
      return "failed";
    }
    // Explicit pass: a completed CheckRun with a pass conclusion, or a
    // StatusContext reporting SUCCESS. Everything else is not-yet-passing.
    const isPass =
      (status === "COMPLETED" && conclusion !== undefined && CI_PASS_CONCLUSIONS.has(conclusion)) ||
      state === "SUCCESS";
    if (!isPass) allPass = false;
  }
  return allPass ? "green" : "pending";
}

/**
 * Poll `gh pr view <pr> --json statusCheckRollup` until CI is green or failed,
 * or the timeout elapses. Transient gh errors are treated as pending (retry).
 * Returns "pending-timeout" if still pending at the deadline — the caller
 * downgrades to pause-needs-human (fail-safe).
 */
async function waitForCiGreen(opts: {
  prNumber: number;
  role: string;
  permissions: RolePermissions;
  execaImpl: typeof defaultExeca;
  pluginRoot: string;
}): Promise<CiGateState> {
  const start = Date.now();
  for (;;) {
    let stdout = "";
    try {
      const r = await gh({
        role: opts.role,
        permissions: opts.permissions,
        subcommand: "pr-view",
        args: [String(opts.prNumber), "--json", "statusCheckRollup"],
        execaImpl: opts.execaImpl,
        pluginRootOverride: opts.pluginRoot,
      });
      stdout = r.stdout;
    } catch {
      // transient — treat as pending and retry until the deadline
    }
    let rollup: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(stdout) as { statusCheckRollup?: unknown };
      if (Array.isArray(parsed.statusCheckRollup)) {
        rollup = parsed.statusCheckRollup as Array<Record<string, unknown>>;
      }
    } catch {
      rollup = [];
    }
    const state = classifyCiRollup(rollup);
    if (state === "green") return "green";
    if (state === "failed") return "failed";
    if (Date.now() - start >= CI_GATE_TIMEOUT_MS) return "pending-timeout";
    await new Promise((resolve) => setTimeout(resolve, CI_GATE_POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run the auto-merge gate for a PR that has reached `done-ready-for-merge`.
 *
 * Implements the six-branch decision from `lib/auto-merge-gate.ts`:
 *  - low + met-threshold → `gh pr merge --squash --delete-branch`
 *  - all other branches → `gh api POST .../labels` with `{"labels":["needs-human"]}`
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.prNumber - PR number to merge or label.
 * @param opts.ref - Execution manifest ref (used to locate `done/<ref>.yaml`).
 * @param opts.sessionUlid - Session ULID of the calling dev session.
 * @param opts.thresholdOverride - Test seam: bypass workspace-config read.
 * @param opts.lastNVerdictsOverride - Test seam: forward into computeAgreement.
 * @param opts.dryRun - Skip gh shell-out; return decision only.
 * @param opts.execaImpl - Test seam for execa subprocess.
 * @param opts.computeAgreementImpl - Test seam for computeAgreement.
 * @param opts.readManifestImpl - Test seam for manifest read.
 * @param opts.loadWorkspaceConfigImpl - Test seam for config read.
 * @param opts.pluginRootOverride - Test seam for plugin root path.
 * @param opts.role - Role name (default: "generalist-dev").
 *
 * Story 4.10b · FR40 · FR41 · FR42
 */
export async function runAutoMergeGate(
  opts: RunAutoMergeGateOptions,
): Promise<AutoMergeGateResult> {
  const role = opts.role ?? "generalist-dev";
  const pluginRoot = opts.pluginRootOverride ?? getPluginRoot();
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const computeAgreementFn = opts.computeAgreementImpl ?? computeAgreement;
  const readManifestFn = opts.readManifestImpl ?? readManifest;
  const loadWorkspaceConfigFn = opts.loadWorkspaceConfigImpl ?? loadWorkspaceConfig;
  const readReviewerResultFn = opts.readReviewerResultImpl ?? readReviewerResultFile;
  const ciGateFn = opts.ciGateImpl ?? waitForCiGreen;
  const dryRun = opts.dryRun ?? false;

  // ------------------------------------------------------------------
  // Step 1: Validate thresholdOverride (if present)
  // ------------------------------------------------------------------
  if (opts.thresholdOverride !== undefined) {
    const t = opts.thresholdOverride;
    if (!Number.isFinite(t) || isNaN(t)) {
      throw new AutoMergeGateThresholdInvalidError({
        threshold: t,
        reason: "must be a finite number (no NaN, no Infinity)",
      });
    }
    if (t < 0 || t > 1) {
      throw new AutoMergeGateThresholdInvalidError({
        threshold: t,
        reason: "must be in range [0, 1]",
      });
    }
  }

  // ------------------------------------------------------------------
  // Step 2: Resolve threshold_used and provisional_trust from config.
  // Overrides (test seams) win; otherwise read .flow/config.yaml once.
  // The threshold path is unchanged (no config read when overridden); the
  // config is only loaded when a real value is needed.
  // ------------------------------------------------------------------
  let threshold_used: number;
  let pluginSettings: PluginSettings | undefined;
  if (opts.thresholdOverride !== undefined) {
    threshold_used = opts.thresholdOverride;
  } else {
    pluginSettings = await loadWorkspaceConfigFn(opts.targetRepoRoot);
    threshold_used = pluginSettings.agreement_threshold;
  }

  let provisional_trust: boolean;
  if (opts.provisionalTrustOverride !== undefined) {
    provisional_trust = opts.provisionalTrustOverride;
  } else {
    pluginSettings = pluginSettings ?? (await loadWorkspaceConfigFn(opts.targetRepoRoot));
    provisional_trust = pluginSettings.provisional_trust;
  }

  // ------------------------------------------------------------------
  // Step 3: Resolve risk_tier. Prefer the done/<ref>.yaml manifest field;
  // fall back to the tier the reviewer computed from the actual PR diff and
  // recorded in reviewer-result.json (the authoritative source — the manifest
  // is not always stamped). Without this fallback the gate sees `undefined`
  // and always pauses (`no-tier-no-signal`).
  // ------------------------------------------------------------------
  const manifestPath = path.join(
    opts.targetRepoRoot,
    ".flow",
    "state",
    "done",
    `${opts.ref}.yaml`,
  );
  const manifest = await readManifestFn(manifestPath);
  let risk_tier = (manifest as { risk_tier?: "low" | "medium" | "high" }).risk_tier;
  if (risk_tier === undefined) {
    const reviewerResult = await readReviewerResultFn(
      opts.targetRepoRoot,
      opts.sessionUlid,
      opts.ref,
    );
    // Trust the reviewer-computed tier ONLY when the result is the authoritative,
    // GREEN verdict for THIS ref. This makes the safety binding deterministic
    // rather than relying on the caller invoking the gate only on a green verdict
    // (a prose mandate, not load-bearing). A non-green verdict, a ref mismatch
    // (e.g. a stale result lingering in a reused session dir), or an absent
    // result leaves risk_tier `undefined` → the gate pauses (`no-tier-no-signal`),
    // the fail-safe outcome.
    if (
      reviewerResult !== null &&
      reviewerResult.ref === opts.ref &&
      reviewerResult.recommendedVerdict === "READY FOR MERGE"
    ) {
      risk_tier = reviewerResult.riskTier?.tier;
    }
  }

  // ------------------------------------------------------------------
  // Step 4: Compute agreement metric
  // ------------------------------------------------------------------
  const agreement_metric = await computeAgreementFn({
    targetRepoRoot: opts.targetRepoRoot,
    lastNVerdicts: opts.lastNVerdictsOverride ?? DEFAULT_AGREEMENT_WINDOW,
  });

  // ------------------------------------------------------------------
  // Step 5: Make the gate decision
  // ------------------------------------------------------------------
  let { decision, reason } = decideAutoMerge({
    risk_tier,
    agreement_metric,
    threshold: threshold_used,
    provisional_trust,
  });

  // ------------------------------------------------------------------
  // Step 6: chat-log line helper (recomputed after the CI gate may downgrade)
  // ------------------------------------------------------------------
  const ratioStr = agreement_metric !== null ? String(agreement_metric.ratio) : "null";
  const composeChatLine = (d: typeof decision, r: typeof reason): string =>
    d === "auto-merge"
      ? `auto-merge fired — PR #${opts.prNumber} merged (risk_tier: ${risk_tier ?? "undefined"}, agreement: ${ratioStr}, threshold: ${threshold_used})`
      : `auto-merge gate paused — PR #${opts.prNumber} labelled needs-human (reason: ${r}, risk_tier: ${risk_tier ?? "undefined"}, agreement: ${ratioStr}, threshold: ${threshold_used})`;

  // ------------------------------------------------------------------
  // Step 7: dryRun shortcut — previews the RISK decision (the CI gate performs
  // gh calls, so it only applies on real execution).
  // ------------------------------------------------------------------
  if (dryRun) {
    return AutoMergeGateResultSchema.parse({
      decision,
      reason,
      risk_tier: risk_tier ?? null,
      agreement_metric,
      threshold_used,
      merged: false,
      labelsApplied: [],
      dryRun: true,
      prNumber: opts.prNumber,
      chatLog: [composeChatLine(decision, reason)],
    });
  }

  // ------------------------------------------------------------------
  // Step 8: Load permissions (needed for all gh calls below).
  // ------------------------------------------------------------------
  const permissions = await loadRolePermissions({ role, pluginRoot });

  // ------------------------------------------------------------------
  // Best-effort `needs-human` labeller. Resolves owner/repo, then POSTs the
  // label. NEVER throws: a thrown subprocess/parse error here would exit the gate
  // non-zero, and the drain's one-shot seam courier can garble a failed command
  // into a non-JSON relay — the 2026-06-03 PR #277 failure, where a bare
  // `BLOCKED` token broke the gate seam so the story paused with a SyntaxError
  // reason and no label. On any failure the label is skipped and the cause is
  // returned as a note; the caller still emits a clean, schema-valid result
  // (surfaced in `chatLog`, never silent).
  // ------------------------------------------------------------------
  const applyNeedsHumanLabel = async (): Promise<{ applied: string[]; note: string | null }> => {
    try {
      const repoViewResult = await gh({
        role,
        permissions,
        subcommand: "repo-view",
        args: ["--json", "owner,name"],
        execaImpl,
        pluginRootOverride: pluginRoot,
      });
      const repoViewJson = JSON.parse(repoViewResult.stdout) as {
        name?: string;
        owner?: { login?: string };
      };
      const owner = repoViewJson.owner?.login ?? "";
      const repo = repoViewJson.name ?? "";
      if (!owner || !repo) {
        throw new Error("missing owner or repo in repo-view shape");
      }
      const labelsUrl = `/repos/${owner}/${repo}/issues/${opts.prNumber}/labels`;
      const labelResult = await gh({
        role,
        permissions,
        subcommand: "api",
        args: [labelsUrl, "--method", "POST", "--input", "-"],
        input: JSON.stringify({ labels: ["needs-human"] }),
        execaImpl,
        pluginRootOverride: pluginRoot,
      });
      const parsed: unknown = JSON.parse(labelResult.stdout);
      if (!Array.isArray(parsed)) {
        throw new Error(`expected array, got ${typeof parsed}`);
      }
      return { applied: ["needs-human"], note: null };
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return { applied: [], note: `needs-human label not applied: ${msg}` };
    }
  };

  // ------------------------------------------------------------------
  // Step 8a: CI gate (Stage-2). Never auto-merge a PR whose CI is not green.
  // Only runs when the risk gate said auto-merge; polls GitHub checks and, on
  // failure or timeout, downgrades to pause-needs-human (reason ci-not-green) —
  // fail-safe. The risk decision is preserved through dryRun (above); this gate
  // is a hard precondition on the real merge.
  // ------------------------------------------------------------------
  const ciLog: string[] = [];
  if (decision === "auto-merge") {
    const ciState = await ciGateFn({
      prNumber: opts.prNumber,
      role,
      permissions,
      execaImpl,
      pluginRoot,
    });
    ciLog.push(`ci gate: ${ciState}`);
    if (ciState !== "green") {
      decision = "pause-needs-human";
      reason = "ci-not-green";
    }
  }

  const chatLine = composeChatLine(decision, reason);

  // ------------------------------------------------------------------
  // Step 9: Execute the side-effect for the (CI-gated) decision. Every branch
  // returns a clean, schema-valid result and NEVER lets a subprocess failure
  // throw out of the gate — a raw throw exits the process non-zero, and the
  // drain's one-shot seam courier can relay a failed command as garbled non-JSON
  // (the PR #277 `BLOCKED`-token seam break). An operational failure (merge
  // refused, label API hiccup, missing permission) folds into pause-needs-human;
  // the operator picks it up from the human-needed bucket with the cause in
  // `chatLog`.
  // ------------------------------------------------------------------
  if (decision === "auto-merge") {
    try {
      // gh pr merge <prNumber> --squash --delete-branch
      await gh({
        role,
        permissions,
        subcommand: "pr-merge",
        args: [String(opts.prNumber), "--squash", "--delete-branch"],
        execaImpl,
        pluginRootOverride: pluginRoot,
      });

      return AutoMergeGateResultSchema.parse({
        decision,
        reason,
        risk_tier: risk_tier ?? null,
        agreement_metric,
        threshold_used,
        merged: true,
        labelsApplied: [],
        dryRun: false,
        prNumber: opts.prNumber,
        chatLog: [...ciLog, chatLine],
      });
    } catch (mergeErr) {
      // The merge did not complete (GitHub refused it, a recoverable gh error, a
      // missing permission, a transient API failure). Fold into pause-needs-human
      // so the gate's stdout stays JSON-only; a human completes the merge.
      decision = "pause-needs-human";
      reason = "merge-failed";
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      const { applied, note } = await applyNeedsHumanLabel();
      const chatLog = [...ciLog, `auto-merge attempt failed: ${mergeMsg}`];
      if (note) chatLog.push(note);
      chatLog.push(composeChatLine(decision, reason));

      return AutoMergeGateResultSchema.parse({
        decision,
        reason,
        risk_tier: risk_tier ?? null,
        agreement_metric,
        threshold_used,
        merged: false,
        labelsApplied: applied,
        dryRun: false,
        prNumber: opts.prNumber,
        chatLog,
      });
    }
  }

  // pause-needs-human: flag the PR for a human (best-effort label, never throws).
  const { applied, note } = await applyNeedsHumanLabel();
  const chatLog = [...ciLog, chatLine];
  if (note) chatLog.push(note);

  return AutoMergeGateResultSchema.parse({
    decision,
    reason,
    risk_tier: risk_tier ?? null,
    agreement_metric,
    threshold_used,
    merged: false,
    labelsApplied: applied,
    dryRun: false,
    prNumber: opts.prNumber,
    chatLog,
  });
}
