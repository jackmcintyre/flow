/**
 * `processDevTranscript` MCP tool — Story 4.3b Task 2; extended by Story 4.5.
 *
 * Pure transcript-in / verdict-out function: receives the dev subagent's final
 * transcript (captured by the SKILL.md prose after the `Task` tool returns),
 * first checks for the locked recoverable-error marker line (Story 4.5), then
 * parses the handoff phrase (Story 4.3b), mutates the in-progress manifest on
 * grammar drift or recoverable error, and returns the next step for the prose layer.
 *
 * **Behavioural contract sources:**
 * - Story 4.3b: `_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract`
 * - Story 4.5: `_bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md § Behavioural contract`
 *
 * This tool MUST NOT spawn anything. The MCP server runs over JSON-RPC stdio
 * and has no access to Claude Code's `Task` tool. Spawn responsibility belongs
 * exclusively to the SKILL.md prose layer.
 *
 * Chat lines flow through the returned `chatLog: string[]` — no console.*.
 * Errors propagate as typed `DomainError`s; `register.ts` wraps them.
 *
 * Story 4.3b Task 2.1–2.5; Story 4.5 Task 4.1–4.5.
 */

import * as path from "node:path";
import { parseHandoff } from "../skills/handoff-parser.js";
import { buildPersonaSpawnPrompt } from "./build-persona-spawn-prompt.js";
import { readManifest, writeManifest } from "../lib/manifest-io.js";
import { PrUrlNotFoundInDevTranscriptError } from "../errors.js";
import { readDevOutcomeFile } from "../lib/read-dev-outcome-file.js";
import { buildBranchSlug } from "../lib/pr-body.js";
import { execa as defaultExeca } from "execa";

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type ProcessDevTranscriptResult =
  | { next: "spawn-reviewer"; reviewerPrompt: string; prNumber: number; chatLog: string[] }
  | { next: "done-blocked-handoff-grammar"; chatLog: string[] }
  | { next: "done-handoff-but-no-review-yet"; chatLog: string[] } // v1: unreachable; declared for ABI stability
  | { next: "done-blocked-gh-defer"; chatLog: string[] }
  | { next: "done-blocked-gh-retry"; chatLog: string[] }
  | { next: "done-blocked-gh-needs-human"; chatLog: string[] }
  // Story 8.19: the dev hit a genuine decision a human must make to proceed
  // correctly. This is NOT a hard block and NOT a successful handoff — the story
  // pauses into the human-needed surface carrying the verbatim question text.
  | { next: "done-needs-human-decision"; question: string; chatLog: string[] };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ProcessDevTranscriptOptions {
  targetRepoRoot: string;
  sessionUlid: string;
  ref: string;
  devTranscript: string;
  /**
   * Test seam for the in-line PR-recovery fallback (Story: dev-outcome seam
   * hardening). Production callers omit it and the real `execa` is used to query
   * GitHub. Injected in tests so the `gh pr list` lookup is deterministic.
   */
  execaImpl?: typeof defaultExeca;
}

// ---------------------------------------------------------------------------
// Recoverable-error locked phrase regex
// (Story 4.5 AC2e / Task 4.1)
// ---------------------------------------------------------------------------

const RECOVERABLE_ERROR_RE =
  /^gh-recoverable: class=(defer|retry|needs-human) subcommand=([a-z0-9-]+) exit=(\d+)/m;

// ---------------------------------------------------------------------------
// Needs-human-decision locked phrase regex
// (Story 8.19 AC1)
// The dev emits this as its last line — instead of the handoff phrase — when it
// hits a genuine decision a human must make to proceed correctly (distinct from
// a normal handoff, a domain-yield, and a hard block). The rest of the line, up
// to the end of line, is the verbatim question text the operator must answer.
// A blank/whitespace-only question does NOT qualify (guards against the dev
// using this as a no-question escape hatch) — it falls through to the handoff
// parse, which then blocks on grammar drift rather than silently pausing.
// ---------------------------------------------------------------------------

const NEEDS_HUMAN_DECISION_RE = /^needs-human-decision:[ \t]*(\S.*\S|\S)[ \t]*$/m;

// ---------------------------------------------------------------------------
// PR URL extraction regex
// (Story 4.6 Task 6.1)
// Matches the rightmost GitHub PR URL in a transcript and extracts the PR number.
// ---------------------------------------------------------------------------

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Process the dev subagent's final transcript.
 *
 * 1. Checks for the locked recoverable-error marker line BEFORE calling `parseHandoff`.
 *    On match: stamps `blocked_by: gh-<class>` on the in-progress manifest and returns
 *    one of the three new `done-blocked-gh-<class>` result variants. (Story 4.5 AC2d)
 *
 * 2. Falls through to `parseHandoff` when no recoverable-error marker is present.
 *    On grammar drift: stamps `blocked_by: "handoff-grammar"` on the in-progress manifest.
 *    On success: calls `buildPersonaSpawnPrompt` for the reviewer and returns the prompt.
 *
 * The SKILL.md prose MUST pass `devTranscript` verbatim — no summarisation,
 * no editing, no extraction. The full final-message string is the contract.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID of the calling dev session.
 * @param opts.ref - Story ref (e.g. `"native:01HZ..."`).
 * @param opts.devTranscript - The dev subagent's complete final message, verbatim.
 */
export async function processDevTranscript(
  opts: ProcessDevTranscriptOptions,
): Promise<ProcessDevTranscriptResult> {
  const { targetRepoRoot, sessionUlid, ref, devTranscript } = opts;
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const chatLog: string[] = [];

  const manifestPath = path.resolve(
    targetRepoRoot,
    ".flow",
    "state",
    "in-progress",
    `${ref}.yaml`,
  );

  // ---------------------------------------------------------------------------
  // Step 0: Check for the locked needs-human-decision marker line FIRST.
  // (Story 8.19 AC1)
  // This is checked before the recoverable-error marker and before the handoff
  // parse because it is a deliberate signal the dev emits INSTEAD of the handoff
  // phrase when it hits a genuine decision a human must make. It must not be
  // confused with a hard block (it carries a concrete question and pauses into
  // the human-needed surface, not the blocked bucket) nor with a successful
  // handoff (no PR is opened). We stamp a descriptive `blocked_by` so the
  // manifest reflects the paused-for-human state rather than a generic block,
  // and return the question text verbatim for the operator-facing surface.
  // ---------------------------------------------------------------------------

  const needsHumanMatch = NEEDS_HUMAN_DECISION_RE.exec(devTranscript);

  if (needsHumanMatch !== null) {
    const question = needsHumanMatch[1]!.trim();

    const currentManifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, {
      ...currentManifest,
      blocked_by: "needs-human-decision",
    });

    chatLog.push(
      `needs human decision — story ${ref} paused for a human. question: ${question}`,
    );

    return { next: "done-needs-human-decision", question, chatLog };
  }

  // ---------------------------------------------------------------------------
  // Step 1: Check for the locked recoverable-error marker line FIRST.
  // (Story 4.5 AC2d / Task 4.1)
  // ---------------------------------------------------------------------------

  const recoverableMatch = RECOVERABLE_ERROR_RE.exec(devTranscript);

  if (recoverableMatch !== null) {
    const errorClass = recoverableMatch[1] as "defer" | "retry" | "needs-human";

    // Stamp blocked_by: gh-<class> on the in-progress manifest.
    // Overwrites any existing blocked_by value (most-recent failure wins per AC2h).
    const currentManifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, {
      ...currentManifest,
      blocked_by: `gh-${errorClass}`,
    });

    // Build the verbatim chat line per AC2f.
    const actionHint = buildActionHint(errorClass);
    chatLog.push(
      `gh recoverable error (class=${errorClass}) — story ${ref} blocked. blocked_by stamped to gh-${errorClass}. Operator action: ${actionHint}`,
    );

    const next =
      errorClass === "defer"
        ? "done-blocked-gh-defer"
        : errorClass === "retry"
          ? "done-blocked-gh-retry"
          : "done-blocked-gh-needs-human";

    return { next, chatLog } as ProcessDevTranscriptResult;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Parse the handoff phrase (existing path — unchanged from Story 4.3b).
  // ---------------------------------------------------------------------------

  const handoffResult = parseHandoff(devTranscript, ref);

  if (!handoffResult.ok) {
    // Grammar drift (or empty transcript) — stamp the manifest with blocked_by.
    const currentManifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, {
      ...currentManifest,
      blocked_by: "handoff-grammar",
    });

    chatLog.push(
      `handoff grammar drift — story ${ref} blocked. expected verbatim phrase: "Handoff to reviewer — story ${ref} ready for review." Edit the manifest to clear blocked_by and re-run /flow:start.`,
    );

    return { next: "done-blocked-handoff-grammar", chatLog };
  }

  // ---------------------------------------------------------------------------
  // Story 4.8b Task 4.3–4.5: Try to read prNumber from dev-outcome.json first.
  // The file is written atomically by runDevTerminalAction after a successful
  // gh pr create — making this path machine-authoritative (no LLM text needed).
  // On ENOENT (file absent): fall through to the PR_URL_RE fallback below.
  // On malformed file: DevOutcomeFileMalformedError propagates uncaught (Task 4.6).
  // ---------------------------------------------------------------------------

  const devOutcome = await readDevOutcomeFile(targetRepoRoot, sessionUlid, ref);

  let prNumber: number;

  if (devOutcome !== null) {
    // Primary path (AC2): use the machine-written prNumber directly.
    prNumber = devOutcome.prNumber;
  } else {
    // Fallback path (AC3): dev-outcome.json absent — scan transcript with PR_URL_RE.
    // Preserved verbatim from Story 4.6 Task 6.1–6.3 for backward compatibility
    // (sessions started before this story was deployed have no dev-outcome.json).

    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    const prUrlReClone = new RegExp(PR_URL_RE.source, PR_URL_RE.flags);
    while ((m = prUrlReClone.exec(devTranscript)) !== null) {
      lastMatch = m;
    }

    if (lastMatch !== null) {
      prNumber = parseInt(lastMatch[1]!, 10);
    } else {
      // Last-resort recovery (dev-outcome seam hardening): no dev-outcome.json AND
      // no PR URL in the (synthesized) handoff. This is the orphan class where the
      // dev opened a PR by hand after the pre-PR gate refused, so nothing recorded
      // the PR. Ask GitHub directly for an open PR on this story's reproduced branch
      // and route it to review ON THE SAME PASS — the in-line analogue of the #287
      // orphan-scan recovery. Without this, a green PR is stranded until the next drain.
      const recovered = await findOpenPrForRef({
        targetRepoRoot,
        ref,
        manifestPath,
        execaImpl,
      });

      if (recovered === null) {
        const tail = devTranscript.slice(-500);
        throw new PrUrlNotFoundInDevTranscriptError({ ref, transcriptTail: tail });
      }

      prNumber = recovered;
      chatLog.push(
        `dev-outcome.json absent and no PR URL in handoff — recovered open PR #${recovered} for ${ref} via gh pr list; routing to review.`,
      );
    }
  }

  // Handoff parsed OK — compute the reviewer spawn prompt.
  const { systemPrompt: reviewerPrompt } = await buildPersonaSpawnPrompt({
    targetRepoRoot,
    role: "generalist-reviewer",
  });

  chatLog.push(
    `handoff received — story ${ref} — spawning generalist-reviewer subagent (clean context)`,
  );

  return { next: "spawn-reviewer", reviewerPrompt, prNumber, chatLog };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function buildActionHint(errorClass: "defer" | "retry" | "needs-human"): string {
  switch (errorClass) {
    case "defer":
      return "wait and re-run /flow:start";
    case "retry":
      return "transient network error; re-run /flow:start (v2 will auto-retry)";
    case "needs-human":
      return "run `gh auth login` then re-run /flow:start";
  }
}

/**
 * Recover the PR number for an orphaned-but-real PR when no dev-outcome.json and
 * no transcript URL are available. Reproduces the dev branch deterministically
 * from `{ref, title}` (the manifest carries the title) — the same slug the dev
 * tool, the dep-merge check, and the orphan scan use — and asks GitHub for an
 * open PR on that head. Returns the PR number, or `null` if it cannot prove one
 * (un-reproducible slug, gh error, empty/!parseable output) — in which case the
 * caller throws the original not-found error. Fail-safe: any failure → null.
 */
async function findOpenPrForRef(opts: {
  targetRepoRoot: string;
  ref: string;
  manifestPath: string;
  execaImpl: typeof defaultExeca;
}): Promise<number | null> {
  let branch: string;
  try {
    const manifest = await readManifest(opts.manifestPath);
    branch = buildBranchSlug({ ref: opts.ref, title: manifest.title });
  } catch {
    return null;
  }

  try {
    const result = await opts.execaImpl(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "1"],
      { cwd: opts.targetRepoRoot },
    );
    const stdout = (result.stdout ?? "").trim();
    if (stdout === "") return null;
    const parsed: unknown = JSON.parse(stdout);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof (parsed[0] as { number?: unknown }).number === "number"
    ) {
      return (parsed[0] as { number: number }).number;
    }
    return null;
  } catch {
    return null;
  }
}
