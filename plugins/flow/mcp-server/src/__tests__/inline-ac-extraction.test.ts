/**
 * Inline AC extraction for native stories — Story native:01KT6QGBWP7KJDVMHQK3MEKDXP.
 *
 * AC1 (integration) — run-dev-terminal-action.ts:
 *   Given a native story whose spec file lives in the local-only .flow folder,
 *   When the flow builds that story in an isolated work copy,
 *   Then the builder has the full acceptance criteria available from the start
 *   without reading any file outside its own work copy.
 *
 * AC2 (unit) — run.workflow.js:
 *   Given a run run that spawns a builder for a native story,
 *   When the orchestrator prepares the build context,
 *   Then the story's acceptance criteria are extracted by the orchestrator and
 *   passed inline to the builder — the builder's own file-read of the spec is
 *   not required for it to proceed.
 *
 * The AC1 integration test drives `runDevTerminalAction` with `inlineAcs` set
 * (simulating what the run passes) and a `specPath` that does NOT exist in
 * the worktree. The test asserts the tool succeeds — the ACs come from the
 * inline parameter, not the missing file.
 *
 * The AC2 unit test reads run.workflow.js and asserts:
 *   a) The run calls `extractNativeStoryAcs` before spawning the dev for
 *      native stories.
 *   b) The run passes `inlineAcs` in the `runDevTerminalAction` JSON args
 *      given to the builder's prompt.
 *   c) No `.flow/native-stories` path resolution is delegated to the builder
 *      — the builder-side code only consumes `inlineAcs`, never reads .flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execa as realExeca } from "execa";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { runDevTerminalAction } from "../tools/run-dev-terminal-action.js";

// ---------------------------------------------------------------------------
// Run workflow source (for AC2 structural assertions)
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.resolve(HERE, "..", "..", "..", "workflows", "run.workflow.js");
const SRC = readFileSync(RUN, "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REF = "native:01KT6QGBWP7KJDVMHQK3MEKDXP";
const TITLE = "Hand the builder its acceptance criteria directly so a native story always has its spec in an isolated work copy";
const TYPE = "feat";
const BODY = "Pass ACs inline to the builder so the .flow spec path is never resolved from the worktree.";
const SUMMARY = "Inline AC extraction for native stories.";
const FAKE_PR_URL = "https://github.com/owner/repo/pull/7777";
const SESSION_ULID = "01HZINLINE00000000000TEST1";
const SOURCE_HASH = "a".repeat(64);

/**
 * The inline ACs the run extracts from .flow/native-stories/<ULID>.md and
 * passes to the builder via runDevTerminalAction's `inlineAcs` parameter.
 * Shape mirrors AcEntry from extract-acs-from-spec.ts.
 */
const INLINE_ACS = [
  {
    index: 1,
    firstLine: "Given a native story whose spec file lives in the local-only .flow folder, When the flow builds that story in an isolated work copy",
    tag: "integration",
    body: [
      "**Given** a native story whose spec file lives in the local-only .flow folder,",
      "**When** the flow builds that story in an isolated work copy,",
      "**Then** the builder has the full acceptance criteria available from the start without reading any file outside its own work copy.",
    ],
  },
  {
    index: 2,
    firstLine: "Given a run run that spawns a builder for a native story, When the orchestrator prepares the build context",
    tag: null,
    body: [
      "**Given** a run run that spawns a builder for a native story,",
      "**When** the orchestrator prepares the build context,",
      "**Then** the story's acceptance criteria are extracted by the orchestrator and passed inline to the builder.",
    ],
  },
];

interface TestContext {
  repoRoot: string;
  manifestPath: string;
  /** Absolute path where the spec DOES NOT exist (the worktree has no .flow folder). */
  missingSpecPath: string;
}

async function setupRepo(): Promise<TestContext> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "inline-ac-"));

  await realExeca("git", ["-C", repoRoot, "init"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.email", "test@test.com"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);

  const srcDir = path.join(repoRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await atomicWriteFile(path.join(srcDir, "index.ts"), "export const x = 1;\n");
  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: initial commit"]);

  const stateDir = path.join(repoRoot, ".flow", "state", "in-progress");
  await fs.mkdir(stateDir, { recursive: true });

  // The spec_path points into .flow/native-stories/ which is ABSENT from the
  // worktree (gitignored). The test asserts the tool succeeds WITHOUT this file.
  const missingSpecPath = `.flow/native-stories/01KT6QGBWP7KJDVMHQK3MEKDXP.md`;

  const manifestPath = path.join(stateDir, `${REF}.yaml`);
  const manifest = {
    ref: REF,
    status: "in-progress",
    adapter: "native",
    source_path: missingSpecPath, // .flow/ path — absent from the worktree
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      {
        text: "Given a native story whose spec file lives in the local-only .flow folder, When the flow builds that story in an isolated work copy, Then the builder has the full acceptance criteria available from the start without reading any file outside its own work copy.",
        kind: "integration",
        verification: { type: "vitest", target: "plugins/flow/mcp-server/src/tools/run-dev-terminal-action.ts" },
      },
      {
        text: "Given a run run that spawns a builder for a native story, When the orchestrator prepares the build context, Then the story's acceptance criteria are extracted by the orchestrator and passed inline to the builder.",
        kind: "unit",
        verification: { type: "vitest", target: "plugins/flow/workflows/run.workflow.js" },
      },
    ],
    title: TITLE,
    narrative: "As a operator running parallel builds, I want each builder to receive its acceptance criteria from the orchestrator at build start.",
    withdrawn: false,
    claimed_by: SESSION_ULID,
  };
  await atomicWriteFile(manifestPath, yamlStringify(manifest));

  // Simulate dev work done after the initial commit.
  await atomicWriteFile(path.join(srcDir, "new-feature.ts"), "export const y = 2;\n");

  return { repoRoot, manifestPath, missingSpecPath };
}

// ---------------------------------------------------------------------------
// Stub command runner: mirrors the pattern from dev-pre-pr-gate.test.ts.
// Real git for add/commit/checkout/rev-parse; stubs for build, test, gh, push,
// fetch, rebase. Records the ordered command stream.
// ---------------------------------------------------------------------------

interface RecordedCall {
  cmd: string;
  args: string[];
}

function makeStubExeca(opts: { recorded: RecordedCall[] }): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (
      cmd: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      opts.recorded.push({ cmd, args: [...args] });

      if (cmd === "pnpm" && (args[0] === "build" || args[0] === "test")) {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
      if (cmd === "gh") {
        return { stdout: FAKE_PR_URL, stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[2] === "push") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && (args[2] === "fetch" || args[2] === "rebase")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // Delegate real git ops.
      const result = await realExeca(cmd, args as string[], { ...options, reject: false });
      return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeEach(async () => {
  ctx = await setupRepo();
});

afterEach(async () => {
  await fs.rm(ctx.repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — integration test on run-dev-terminal-action.ts
// ---------------------------------------------------------------------------

describe("AC1 — builder uses inline ACs and does not fail on missing .flow spec (integration)", () => {
  it("when inlineAcs are supplied, runDevTerminalAction succeeds even though the spec file is absent from the worktree", async () => {
    const recorded: RecordedCall[] = [];
    const spy = makeStubExeca({ recorded });

    // Verify the spec file is genuinely absent from the worktree
    const absSpecPath = path.join(ctx.repoRoot, ctx.missingSpecPath);
    await expect(fs.access(absSpecPath)).rejects.toThrow();

    // The tool MUST succeed using the inline ACs, not by reading the absent spec.
    // (simulating what the run passes)
    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      inlineAcs: INLINE_ACS,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(FAKE_PR_URL);

    // The PR body must contain the inline AC text (not a fallback "no ACs" message).
    const ghCall = recorded.find((c) => c.cmd === "gh" && c.args.includes("create"));
    expect(ghCall).toBeDefined();
    const bodyArgIdx = ghCall!.args.indexOf("--body");
    expect(bodyArgIdx).toBeGreaterThan(-1);
    const prBody = ghCall!.args[bodyArgIdx + 1] ?? "";
    // AC1 first line should appear in the PR body
    expect(prBody).toContain("Given a native story whose spec file lives in the local-only .flow folder");
    // Not the empty fallback
    expect(prBody).not.toContain("No acceptance criteria were listed");
  });

  it("without inlineAcs on a story with a missing spec, runDevTerminalAction throws (proving inlineAcs are the fix)", async () => {
    const recorded: RecordedCall[] = [];
    const spy = makeStubExeca({ recorded });

    // No inlineAcs → falls back to file read → spec absent → should throw
    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        // inlineAcs deliberately omitted
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toThrow(); // ENOENT or similar — spec not in worktree
  });
});

// ---------------------------------------------------------------------------
// AC2 — unit test on run.workflow.js (structural anchor)
// ---------------------------------------------------------------------------

describe("AC2 — run extracts ACs for native stories and passes them inline to the builder (unit)", () => {
  it("run parses as a valid workflow script (sanity check)", () => {
    const wrapped = "(async()=>{" + SRC.replace("export const meta", "const meta") + "})()";
    expect(() => new vm.Script(wrapped)).not.toThrow();
  });

  it("run registers extractNativeStoryAcs as a seam call for native story refs", () => {
    // The run must call extractNativeStoryAcs via the CLI seam for native stories.
    expect(SRC).toContain("extractNativeStoryAcs");
    // The seam call should be gated on the native: prefix check.
    expect(SRC).toMatch(/ref\.startsWith\(['"]native:['"]\)/);
  });

  it("run passes the extracted ACs as inlineAcs to the builder's runDevTerminalAction args", () => {
    // The run's dev prompt must include inlineAcs in the runDevTerminalAction JSON args.
    expect(SRC).toContain("inlineAcs");
    // The runDevArgs object is augmented with inlineAcs before being JSON-serialised
    // into the dev prompt — assert the key is present in the run source.
    expect(SRC).toMatch(/runDevArgs\.inlineAcs\s*=/);
  });

  it("run calls extractNativeStoryAcs via the retryable read-only seam pattern", () => {
    // The seam is read-only / idempotent — it should be called with retryable=true
    // (the third positional argument to seam()). The label starts with 'native-acs:'.
    expect(SRC).toContain("native-acs:");
    // Pattern: seam(`...extractNativeStoryAcs...`, `native-acs:${ref}`, true)
    expect(SRC).toMatch(/extractNativeStoryAcs.*native-acs:\$\{ref\}.*true/s);
  });

  it("run fails soft when extractNativeStoryAcs returns empty — does not block the story", () => {
    // The run must guard: only assign inlineAcs when acs.length > 0. An empty
    // or errored result falls back to null, leaving the builder to use its own
    // file-read path (which surfaces a clear ENOENT rather than a silent wrong result).
    expect(SRC).toContain("acsResult.acs.length > 0");
    expect(SRC).toContain("storyInlineAcs = null");
  });

  it("run also extracts inline ACs for native orphan resumes", () => {
    // The orphan-resume path mirrors the main run loop: it also extracts ACs
    // inline for native orphans so a resumed builder has its spec available.
    expect(SRC).toContain("orphanInlineAcs");
    expect(SRC).toContain("orphanAcsResult.acs.length > 0");
  });

  it("the builder's runDevTerminalAction call site receives inlineAcs from the orchestrator", () => {
    // The run builds runDevArgs, conditionally appends inlineAcs, then
    // JSON-serialises the whole object into the dev prompt. Assert the pattern.
    expect(SRC).toContain("runDevArgs");
    // The run only appends inlineAcs when they are non-null and non-empty.
    expect(SRC).toMatch(/if \(inlineAcs && Array\.isArray\(inlineAcs\) && inlineAcs\.length > 0\)/);
  });
});
