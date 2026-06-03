/**
 * Story 8.15 — per-story reviewer-result isolation within a session.
 *
 * A `flow-drain` run shares ONE session ULID across every story it processes.
 * Before 8.15 the reviewer verdict was stored at a single per-session path
 * (`.flow/state/sessions/<sessionUlid>/reviewer-result.json`), so the next
 * story's `runReviewerSession` clobbered the previous story's verdict — making a
 * failed verdict-seam unrecoverable, and corrupting verdicts outright under a
 * future parallel drain.
 *
 * This suite exercises the WRITER (`runReviewerSession`) and the READER
 * (`processReviewerTranscript`, plus its shared `readReviewerResultFile`)
 * end-to-end for two distinct refs in ONE session and asserts that writing
 * ref B leaves ref A's verdict intact and independently readable.
 *
 * AC1 — two stories in one session keep independent reviewer-result files.
 * AC2 — writer and reader agree on a per-ref, deterministic, path-safe path;
 *       the colon in a BMad-style ref is sanitised into a path-safe component.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runReviewerSession } from "../run-reviewer-session.js";
import { processReviewerTranscript } from "../process-reviewer-transcript.js";
import {
  readReviewerResultFile,
  reviewerResultFilePath,
  sanitiseRefForPathSegment,
} from "../../lib/read-reviewer-result-file.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import { makeGhExecaStub } from "../../__tests__/test-helpers/gh-execa-stub.js";

// ---------------------------------------------------------------------------
// Constants — two distinct stories sharing ONE session ULID.
//
// The refs use the native adapter (valid 26-char Crockford ULIDs). Each ref
// carries a colon — the path-unsafe character the per-ref derivation must
// sanitise (the same class of character as the colon in a BMad-style ref,
// which the AC2 pure tests below also cover with a literal `bmad:8.15`).
// ---------------------------------------------------------------------------

const SESSION_ULID = "NK5T8BG0CFJQRZ2469MPWX1Y37";
const ULID_A = "EQCPVZ7HMKR0WD3AGN5T8BJX1Y";
const ULID_B = "HWJX1Y5T8BG0NPRZ2469CFKMQS";
const REF_A = `native:${ULID_A}`;
const REF_B = `native:${ULID_B}`;
const PR_A = 813;
const PR_B = 814;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function writeStandardsDoc(root: string): Promise<void> {
  const standardsPath = path.join(root, "docs", "standards.md");
  await fs.mkdir(path.dirname(standardsPath), { recursive: true });
  await atomicWriteFile(
    standardsPath,
    [
      'version: "1.0.0"',
      'updated: "2026-05-30"',
      "criteria:",
      '  - name: "story-aligned"',
      '    what: "The PR implements only what the story requires."',
      '    check: "Map each diff hunk to an AC."',
      '    anti_criterion: "Scope creep."',
      "",
    ].join("\n"),
  );
}

/**
 * A native story spec. The native adapter parses YAML frontmatter for the
 * structured fields; the reviewer's AC-walk re-parses the markdown body for
 * `artifact:`/`vitest:` markers via `extractAcsFromSpec`.
 */
function makeSourceStorySpec(opts: { title: string; artifact: string }): string {
  return [
    "---",
    `title: "${opts.title}"`,
    'narrative: "As a maintainer / I want per-story isolation / so verdicts survive."',
    "acceptance_criteria:",
    '  - text: "AC1 — artifact existence check."',
    "    kind: unit",
    "depends_on: []",
    "withdrawn: false",
    "---",
    "",
    "# Story",
    "",
    "## Narrative",
    "",
    "As a maintainer, I want per-story isolation, so that verdicts survive.",
    "",
    "## Acceptance Criteria",
    "",
    "**AC1:**",
    "**Given** the artifact path, **When** the reviewer checks the filesystem, **Then** the file is present.",
    "",
    `artifact: ${opts.artifact}`,
    "",
  ].join("\n");
}

let tmpRoot: string;
let pluginRoot: string;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flow-8-15-isolation-"));
  pluginRoot = path.join(tmpRoot, "plugin");

  // Adapter config — native. The native adapter resolves `native:<ULID>` to
  // `.flow/native-stories/<ULID>.md`.
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );

  await writeStandardsDoc(tmpRoot);

  // Plugin permissions for the gh wrapper.
  await fs.mkdir(path.join(pluginRoot, "permissions"), { recursive: true });
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "gh-error-map.yaml"),
    `entries:\n  - exit_code: 4\n    stderr_regex: "API rate limit exceeded"\n    class: defer\n`,
  );
  await atomicWriteFile(
    path.join(pluginRoot, "permissions", "generalist-reviewer.yaml"),
    [
      "role: generalist-reviewer",
      "tools_allow:",
      "  - runReviewerSession",
      "gh_allow:",
      "  - pr-view",
      "  - pr-diff",
      "  - api",
      "  - repo-view",
      "gh_allow_args: {}",
    ].join("\n"),
  );

  // Story specs: A's artifact is missing (→ NEEDS CHANGES); B's is present
  // (→ READY FOR MERGE). Distinct verdicts make cross-contamination detectable.
  const storiesDir = path.join(tmpRoot, ".flow", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  await atomicWriteFile(
    path.join(storiesDir, `${ULID_A}.md`),
    makeSourceStorySpec({ title: "Story A", artifact: "missing.txt" }),
  );
  await atomicWriteFile(
    path.join(storiesDir, `${ULID_B}.md`),
    makeSourceStorySpec({ title: "Story B", artifact: "present.txt" }),
  );

  // The artifact for B must exist (the AC-walk's fs.access check runs against
  // the PR-branch worktree, which the stub populates from tmpRoot). A's is absent.
  await atomicWriteFile(path.join(tmpRoot, "present.txt"), "ok\n");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// gh + git execa stub.
//
// runReviewerSession → materialisePrBranchWorktree runs:
//   gh pr view --json headRefName,headRefOid  (JSON)
//   git fetch origin <headRefName>            (exit 0)
//   git worktree add <path> <sha>             (must create the dir, populated
//                                              from tmpRoot so artifact checks
//                                              find the same fixtures)
//   git worktree remove <path> --force        (cleanup)
// plus gh pr diff (any) and gh pr view --json commits (for risk-tier).
// ---------------------------------------------------------------------------

function makeStub(): ReturnType<typeof makeGhExecaStub> {
  const stub = async (cmd: string, args: string[]): Promise<unknown> => {
    if (cmd === "gh") {
      const isHeadRefQuery =
        args.includes("headRefName,headRefOid") ||
        (args.includes("--json") && args.some((a) => a.includes("headRefOid")));
      if (isHeadRefQuery) {
        return {
          stdout: JSON.stringify({
            headRefName: "pr-head",
            headRefOid: "aabbccddaabbccddaabbccddaabbccddaabbccdd",
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      if (args.includes("diff")) {
        return {
          stdout: "diff --git a/present.txt b/present.txt\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      // pr view --json commits (risk-tier) and any other gh call.
      return { stdout: '["chore: stub commit"]', stderr: "", exitCode: 0, timedOut: false };
    }
    if (cmd === "git") {
      if (args[0] === "worktree" && args[1] === "add") {
        const worktreePath = args[2];
        if (worktreePath) {
          await fs.mkdir(worktreePath, { recursive: true });
          // Populate top-level files from tmpRoot so artifact checks resolve.
          const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              await fs.copyFile(
                path.join(tmpRoot, entry.name),
                path.join(worktreePath, entry.name),
              );
            }
          }
        }
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        const removePath = args[2];
        if (removePath) {
          await fs.rm(removePath, { recursive: true, force: true }).catch(() => {});
        }
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
      // git fetch and any other git command.
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    }
    // pnpm vitest etc. — not exercised by these artifact-only ACs.
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  };
  return stub as unknown as ReturnType<typeof makeGhExecaStub>;
}

// ---------------------------------------------------------------------------
// AC2 — pure path-derivation: colon sanitisation + writer/reader agreement.
// ---------------------------------------------------------------------------

describe("AC2 — per-ref path derivation is deterministic and path-safe", () => {
  it("sanitises the BMad-ref colon into a single path-safe segment", () => {
    const seg = sanitiseRefForPathSegment("bmad:8.15");
    expect(seg).toBe("bmad_8.15");
    expect(seg).not.toContain(":");
    expect(seg).not.toContain("/");
  });

  it("never yields an empty or traversal-only segment", () => {
    expect(sanitiseRefForPathSegment("")).toBe("_");
    expect(sanitiseRefForPathSegment(".")).toBe("_");
    expect(sanitiseRefForPathSegment("..")).toBe("_");
    expect(sanitiseRefForPathSegment("../../etc/passwd")).not.toContain("/");
  });

  it("two distinct refs map to two distinct files under the same session dir", () => {
    const a = reviewerResultFilePath(tmpRoot, SESSION_ULID, REF_A);
    const b = reviewerResultFilePath(tmpRoot, SESSION_ULID, REF_B);
    expect(a).not.toBe(b);
    const sessionDir = path.join(tmpRoot, ".flow", "state", "sessions", SESSION_ULID);
    expect(a.startsWith(sessionDir + path.sep)).toBe(true);
    expect(b.startsWith(sessionDir + path.sep)).toBe(true);
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });
});

// ---------------------------------------------------------------------------
// AC1 — writer + reader end-to-end: writing B does not clobber A.
// ---------------------------------------------------------------------------

describe("AC1 — two stories in one session keep independent reviewer-result files", () => {
  it("runReviewerSession(A) then runReviewerSession(B) leaves A's persisted result intact and independently readable", async () => {
    // Writer: ref A in the shared session.
    const resultA = await runReviewerSession({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: REF_A,
      prNumber: PR_A,
      execaImpl: makeStub(),
      pluginRootOverride: pluginRoot,
    });

    // Read A's persisted result NOW so we can prove it survives B's write.
    const fileABefore = await readReviewerResultFile(tmpRoot, SESSION_ULID, REF_A);
    expect(fileABefore).not.toBeNull();
    expect(fileABefore!.ref).toBe(REF_A);
    expect(fileABefore!.prNumber).toBe(PR_A);
    expect(fileABefore!.recommendedVerdict).toBe(resultA.recommendedVerdict);

    // Writer: ref B in the SAME session ULID. Pre-8.15 this overwrote the single
    // per-session reviewer-result.json and clobbered A's verdict.
    const resultB = await runReviewerSession({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: REF_B,
      prNumber: PR_B,
      execaImpl: makeStub(),
      pluginRootOverride: pluginRoot,
    });

    // The two stories produced DIFFERENT verdicts (A: artifact missing; B: present).
    expect(resultA.recommendedVerdict).not.toBe(resultB.recommendedVerdict);

    // Reader: A is STILL independently readable after B was written, and still
    // carries A's own identity (ref + PR number) and verdict — not B's.
    const fileAAfter = await readReviewerResultFile(tmpRoot, SESSION_ULID, REF_A);
    expect(fileAAfter).not.toBeNull();
    expect(fileAAfter!.ref).toBe(REF_A);
    expect(fileAAfter!.prNumber).toBe(PR_A);
    expect(fileAAfter!.recommendedVerdict).toBe(resultA.recommendedVerdict);
    // Writing B did not corrupt A: A's persisted result is byte-for-byte unchanged.
    expect(fileAAfter).toEqual(fileABefore);

    // Reader: B carries B's own identity, independently.
    const fileB = await readReviewerResultFile(tmpRoot, SESSION_ULID, REF_B);
    expect(fileB).not.toBeNull();
    expect(fileB!.ref).toBe(REF_B);
    expect(fileB!.prNumber).toBe(PR_B);
    expect(fileB!.recommendedVerdict).toBe(resultB.recommendedVerdict);

    // The two result files are physically distinct on disk (per-ref namespacing).
    expect(reviewerResultFilePath(tmpRoot, SESSION_ULID, REF_A)).not.toBe(
      reviewerResultFilePath(tmpRoot, SESSION_ULID, REF_B),
    );
  });

  it("processReviewerTranscript reads the requested ref's result, not whichever story ran last", async () => {
    // Seed both reviewer-result files via the real writer, in one session.
    const resultA = await runReviewerSession({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: REF_A,
      prNumber: PR_A,
      execaImpl: makeStub(),
      pluginRootOverride: pluginRoot,
    });
    const resultB = await runReviewerSession({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: REF_B,
      prNumber: PR_B,
      execaImpl: makeStub(),
      pluginRootOverride: pluginRoot,
    });

    // The reader is keyed by ref. A ran first, B ran LAST. Route the reader at
    // ref A: if it (pre-8.15) read whichever story ran last it would see B's
    // file; per-8.15 it must read A's own file. A's artifact is missing →
    // NEEDS CHANGES, which stamps blocked_by and leaves the manifest in-progress
    // (no completeStory move → no claim-time snapshot sidecar needed).
    expect(resultA.recommendedVerdict).toBe("NEEDS CHANGES");
    expect(resultB.recommendedVerdict).toBe("READY FOR MERGE");

    const inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
    await fs.mkdir(inProgressDir, { recursive: true });
    const manifestPathA = path.join(inProgressDir, `${REF_A}.yaml`);
    await atomicWriteFile(
      manifestPathA,
      [
        `ref: "${REF_A}"`,
        "status: in-progress",
        "adapter: native",
        `source_path: .flow/native-stories/${ULID_A}.md`,
        `source_hash: ${"a".repeat(64)}`,
        "depends_on: []",
        "acceptance_criteria:",
        '  - text: "AC1 — artifact existence check."',
        "    kind: unit",
        'title: "Story A"',
        'narrative: "As a maintainer / I want isolation / so verdicts survive."',
        "withdrawn: false",
        `claimed_by: "${SESSION_ULID}"`,
        "",
      ].join("\n"),
    );

    const readerA = await processReviewerTranscript({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: REF_A,
      manifestPath: manifestPathA,
    });
    // A's verdict was NEEDS CHANGES → the reader routes to the needs-changes
    // branch by reading A's per-ref result file. If it had read B's file (the
    // last story to run), it would have returned done-ready-for-merge instead.
    expect(readerA.next).toBe("done-blocked-reviewer-needs-changes");

    // B's file is still present and unmodified — its identity intact.
    const fileB = await readReviewerResultFile(tmpRoot, SESSION_ULID, REF_B);
    expect(fileB).not.toBeNull();
    expect(fileB!.ref).toBe(REF_B);
    expect(fileB!.prNumber).toBe(PR_B);
    expect(fileB!.recommendedVerdict).toBe("READY FOR MERGE");
  });
});
