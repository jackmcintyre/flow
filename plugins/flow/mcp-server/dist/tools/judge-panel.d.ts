/**
 * `runJudgePanel` composite MCP tool — Story 9.3 (gate 1, Tier 1).
 *
 * The diverse-lens judge panel. Story 9.2 produces a Tier-0-clean draft; this
 * tool runs the panel that judges its *quality* against the rubric
 * (`_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md` §3).
 *
 * **The deterministic seam (the key reuse).** The reviewer derives a verdict by
 * a closed algorithm and persists it to a per-session result file, then reads it
 * back through a typed reader (`run-reviewer-session.ts` +
 * `read-reviewer-result-file.ts`). This tool mirrors that exactly, per lens: each
 * lens judge writes a `LensVerdict` to its own per-lens result file under the
 * session dir; the panel reads the FIVE files (never the judge's transcript),
 * validates each against `LensVerdictSchema`, and assembles a `PanelVerdict`.
 * Load-bearing decisions live in files, not narration.
 *
 * **Lens diversity is structural.** One judge per Tier-1 lens (structure,
 * verifiability, discipline, domain, considered), each from a DISTINCT role. A
 * panel that shares the author's blind spots rubber-stamps — that scar is the
 * whole reason lens diversity is non-negotiable. The panel fails loudly on a
 * missing lens role (`LensJudgeUnavailableError`) or a role bound to two lenses
 * (`DuplicateLensJudgeError`), rather than silently dropping a lens and reporting
 * a clean sweep.
 *
 * **The Considered bar scales with risk tier.** The panel classifies the draft's
 * risk tier through the existing `classifyRiskTier` and passes the tier to the
 * considered judge so the rubric's tiered bar (§3.5) is applied: a low-risk draft
 * passes on "names what could break + pins the top failure"; a medium/high draft
 * must clear cold-dev sufficiency (no open question without a defaulted answer).
 *
 * **The panel never blesses.** It produces the verdict set and writes NOTHING to
 * the readiness flag or any manifest — that adjudication is Story 9.4's (the
 * Quality Lead's) call. This tool's only writes are the per-lens verdict files
 * (when the production judge runner is used) and one `panel.graded` telemetry
 * event on a completed run.
 *
 * **The spawn lives in the skill, not the tool.** Spawning a subagent per lens
 * is the `/flow:judge` SKILL.md prose layer's job (it has the `Task` tool). This
 * tool takes an injected `judgeRunner` — the seam the skill wires to real Task
 * spawns and that tests wire to deterministic fixture writers. The tool owns
 * orchestration + the deterministic file read + aggregation; it does not spawn.
 */
import { type LensName, type LensVerdict, type PanelVerdict } from "../schemas/lens-verdict.js";
/**
 * The draft under judgement. Mirrors the spec fields a judge needs to grade —
 * the panel does not read the draft from disk itself (the caller already has it),
 * which keeps the tool adapter-agnostic and easy to drive deterministically.
 */
export interface JudgeDraft {
    /** Draft ref (`native:01HZ...` or `bmad:9.3`) — used for the per-lens file path. */
    ref: string;
    /** The draft's title (carried into the judge context for grounding). */
    title: string;
    /** The full draft spec text the judge grades against the rubric lens. */
    specText: string;
    /**
     * POSIX-style relative paths the draft expects to touch, fed to the risk
     * classifier for the Considered-lens bar. Optional — an empty list is a
     * conservative "no signal" input.
     *
     * Only consulted when `riskTier` (below) is absent. When the manifest already
     * carries a persisted `risk_tier` (Story 10.4), pass it as `riskTier` and the
     * panel uses it directly — it does NOT recompute over these paths.
     */
    changedPaths?: string[];
    /** Commit-subject signals for the classifier (usually empty at draft time). */
    commitMessages?: string[];
    /** Authored-source diff size for the classifier. Defaults to 0 at draft time. */
    diffSize?: number;
    /**
     * The draft's persisted risk tier (Story 10.4 — `manifest.risk_tier`). When
     * present this is the SINGLE SOURCE OF TRUTH for the Considered-lens bar: the
     * panel uses it verbatim and does NOT recompute from `changedPaths`. Absent
     * (legacy / BMad drafts with no persisted tier) → the panel falls back to
     * classifying from `changedPaths`/`commitMessages`/`diffSize` as before.
     *
     * This closes the author-time fallback bug: before a build there is no diff,
     * so recomputing from the (empty) author-time signal silently defaulted to the
     * fallback tier. Scan now stamps `risk_tier` from the story's declared paths;
     * the panel reads that persisted value.
     */
    riskTier?: "low" | "medium" | "high";
}
/**
 * The lens→role binding. Exactly one DISTINCT role per Tier-1 lens (rubric §3).
 * The panel validates this is total over `LENS_NAMES` and injective before it
 * spawns anything.
 *
 * Default binding (rubric §3 brackets): structure→architect,
 * verifiability→test-specialist, discipline→generalist-reviewer,
 * domain→generalist-dev (domain expert), considered→retro-analyst
 * (adversarial / Quality-Lead-adjacent). The caller may override per its hired
 * roster; Story 9.4 will pin the Quality-Lead binding.
 */
export type LensRoleBinding = Record<LensName, string>;
/**
 * The judge-spawn seam. Given the lens, its role, the draft, the risk tier (so
 * the considered judge can apply the tiered bar), and the absolute path the
 * judge MUST write its `LensVerdict` to, this runs the judge.
 *
 * In production the `/flow:judge` skill wires this to a real `Task` spawn whose
 * subagent writes the verdict file. In tests it is injected to write a fixture
 * file. The runner's RETURN VALUE is ignored — the panel reads the file. This is
 * the deterministic-seam discipline: the verdict transport is the file, never the
 * runner's (or a judge's transcript's) say-so.
 */
export type JudgeRunner = (input: {
    lens: LensName;
    role: string;
    draft: JudgeDraft;
    riskTier: "low" | "medium" | "high";
    /** Absolute path the judge MUST write its LensVerdict JSON to. */
    resultFilePath: string;
}) => Promise<void>;
export interface RunJudgePanelOptions {
    targetRepoRoot: string;
    sessionUlid: string;
    draft: JudgeDraft;
    /** Lens→role binding (one distinct role per lens). */
    lensRoles: LensRoleBinding;
    /** The judge-spawn seam (skill wires real Task; tests inject a writer). */
    judgeRunner: JudgeRunner;
    /**
     * Tier-0 status the panel re-asserts on the verdict. Story 9.2 enforces Tier 0
     * at authoring; the panel does not re-implement the checks. Defaults to "pass"
     * (the panel only runs on a Tier-0-clean draft).
     */
    tier0?: "pass" | "fail";
    /** Plugin root override — test seam for the risk classifier's spec lookup. */
    pluginRootOverride?: string;
}
export interface RunJudgePanelResult {
    /** The classified risk tier that selected the Considered-lens bar. */
    riskTier: "low" | "medium" | "high";
    /** The aggregated, schema-validated panel verdict. */
    verdict: PanelVerdict;
}
/**
 * Deterministically derive the absolute path to a draft's per-lens verdict file
 * within a session, namespaced per ref AND per lens.
 *
 * Layout:
 *   `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<sanitised-ref>/judge-<lens>.json`
 *
 * Mirrors `reviewerResultFilePath` (same session/ref namespacing — Story 8.15)
 * with a per-lens leaf so the five lens judges never clobber each other. Used by
 * BOTH the judge runner (which writes) and the panel reader (which reads) so they
 * cannot disagree on where a verdict lives.
 */
export declare function lensVerdictFilePath(targetRepoRoot: string, sessionUlid: string, ref: string, lens: LensName): string;
/**
 * Read, parse, and validate a single lens's verdict file. Throws
 * `LensVerdictFileMalformedError` on: absent file, unparseable JSON, a shape
 * that fails `LensVerdictSchema` (including the empty-`missed` guard the schema
 * enforces via `.min(1)`), or a `lens`/`role` that disagrees with what the panel
 * asked this judge to grade.
 *
 * The lens/role cross-check stops a judge from grading the wrong lens (or
 * mislabelling its role) and the panel silently accepting it.
 */
export declare function readLensVerdictFile(opts: {
    filePath: string;
    expectedLens: LensName;
    expectedRole: string;
}): Promise<LensVerdict>;
/**
 * Validate the lens→role binding: total over the five lenses and injective (one
 * distinct role per lens). Throws `LensJudgeUnavailableError` for a missing lens
 * role and `DuplicateLensJudgeError` for a role shared across lenses.
 *
 * Exported for unit testing.
 */
export declare function validateLensRoleBinding(lensRoles: LensRoleBinding): void;
/**
 * Run the judge panel over a draft and return the aggregated `PanelVerdict`.
 *
 * Steps:
 *  1. Validate the lens→role binding (total + injective). Fail loudly otherwise.
 *  2. Classify the draft's risk tier (selects the Considered-lens bar).
 *  3. For each of the five lenses, derive its result-file path and invoke the
 *     injected `judgeRunner` (the spawn seam). Run lenses serially so a thrown
 *     runner error stops the panel deterministically.
 *  4. Read each lens's verdict FILE (never the runner's return), validating shape
 *     + lens/role agreement. The empty-`missed` guard is enforced by the schema.
 *  5. Assemble the `PanelVerdict` (tier0 + five lens verdicts), validate it
 *     against `PanelVerdictSchema`, emit one `panel.graded` telemetry event, and
 *     return. The panel writes NO readiness flag / manifest.
 */
export declare function runJudgePanel(opts: RunJudgePanelOptions): Promise<RunJudgePanelResult>;
/**
 * The default lens→role binding from the rubric §3 brackets.
 *
 * Exported for documentation of the rubric §3 intent. The OPERATIVE path for
 * auto-staffing is `resolveLensRoleBinding`, which derives the binding from the
 * live hired roster. Each lens is bound to a DISTINCT role.
 */
export declare const DEFAULT_LENS_ROLES: LensRoleBinding;
/**
 * Resolve the lens→role binding from a live hired roster using maximum bipartite
 * matching (augmenting paths / Kuhn's algorithm).
 *
 * Algorithm:
 *  1. For each lens, compute its candidate list = preference list ∩ hiredRoles
 *     (filtered in preference order so the preferred specialist is tried first).
 *  2. Run Kuhn's augmenting-path matching: iterate lenses in LENS_NAMES order;
 *     for each lens, DFS through candidates (in preference order) looking for a
 *     free role or an augmenting path through an already-matched lens.
 *  3. If all five lenses are covered → return the binding (passes
 *     validateLensRoleBinding by construction).
 *  4. If any lens is uncovered → throw `LensJudgeUnavailableError` naming the
 *     FIRST uncovered lens in LENS_NAMES order.
 *
 * This is the only correct approach for the default roster: greedy first-match
 * fails because structure and discipline share planner/generalist-reviewer as
 * fallbacks and collide. The augmenting-path search resolves conflicts by
 * reassigning an already-matched lens to a different candidate when doing so
 * frees a slot for the current lens.
 *
 * Exported for unit testing.
 */
export declare function resolveLensRoleBinding(hiredRoles: string[]): LensRoleBinding;
export interface WriteLensVerdictOptions {
    targetRepoRoot: string;
    sessionUlid: string;
    ref: string;
    lens: LensName;
    role: string;
    pass: boolean;
    missed: string;
}
export interface WriteLensVerdictResult {
    resultFilePath: string;
}
/**
 * Validate and write a single lens judge's `LensVerdict` to its per-lens result
 * file. The judge subagent calls this once; the panel reader (`aggregateJudgePanel`
 * / `runJudgePanel`) reads the file back. The `LensVerdictSchema` validation here
 * means the empty-`missed` guard fails AT WRITE TIME — a malformed verdict can
 * never reach disk.
 */
export declare function writeLensVerdict(opts: WriteLensVerdictOptions): Promise<WriteLensVerdictResult>;
export interface AggregateJudgePanelOptions {
    targetRepoRoot: string;
    sessionUlid: string;
    draft: JudgeDraft;
    lensRoles: LensRoleBinding;
    tier0?: "pass" | "fail";
    pluginRootOverride?: string;
}
/**
 * Aggregate the five already-written per-lens verdict files into a `PanelVerdict`.
 * The skill calls this after its spawn loop. Identical orchestration to
 * `runJudgePanel` MINUS the spawn — it uses a no-op judge runner that asserts the
 * file exists (the judge wrote it during the skill's spawn loop) and reads it.
 *
 * Sharing the core means the classify → read-files → validate → telemetry path is
 * exercised by the same code `runJudgePanel`'s tests cover.
 */
export declare function aggregateJudgePanel(opts: AggregateJudgePanelOptions): Promise<RunJudgePanelResult>;
export type { LensName, LensVerdict, PanelVerdict };
