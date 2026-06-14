/**
 * fix(01KV43ET): the reviewer must FAIL a vitest acceptance check that executed
 * zero tests instead of passing it silently.
 *
 * Background: runVitestCheck runs `pnpm vitest --run -t <marker>` and treated
 * exit 0 as "pass". But `-t` is a test-NAME filter; the native-story manifest
 * convention sets the marker to a SOURCE-FILE path, which matches no test name, so
 * vitest skips every test and exits 0 — a VACUOUS PASS that signed off a whole
 * class of acceptance criteria without running a single test (reproduced:
 * `vitest --run -t "drain.workflow.js"` → all skipped, exit 0). This test pins the
 * fix: zero executed tests is never a pass.
 *
 * vitest: plugins/flow/mcp-server/src/tools/__tests__/reviewer-vitest-zero-match.test.ts
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runVitestCheck,
  countExecutedTests,
} from "../run-reviewer-session.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";

// runVitestCheck returns the AcResult union; the runnable-vitest variant carries
// `status`. Narrow to it (the manual-check-required variant has no status).
type RunnableAc = Extract<Awaited<ReturnType<typeof runVitestCheck>>, { status: string }>;
function runnable(r: Awaited<ReturnType<typeof runVitestCheck>>): RunnableAc {
  if (!("status" in r)) {
    throw new Error(`expected a runnable-vitest result, got ${JSON.stringify(r)}`);
  }
  return r as RunnableAc;
}

// ── A stub that mimics execa's result shape, returning canned vitest output. ──
function makeExecaStub(stdout: string, exitCode: number) {
  return (async () => ({
    stdout,
    stderr: "",
    exitCode,
    timedOut: false,
    // execa results carry more fields; runVitestCheck only reads these.
  })) as unknown as Parameters<typeof runVitestCheck>[5];
}

// Realistic vitest text-reporter summaries (plain, as emitted without a TTY).
const ALL_SKIPPED =
  "\n Test Files  222 skipped (222)\n      Tests  2811 skipped (2811)\n   Start at  08:11:41\n";
const PASSED =
  "\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Start at  08:11:41\n";
const PASSED_WITH_SOME_SKIPPED =
  "\n Test Files  1 passed (1)\n      Tests  2 passed | 1 skipped (3)\n";
const FAILED =
  "\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n";
const NO_FILES = "No test files found, exiting with code 1\n";

let tmpRoot: string;

beforeEach(async () => {
  // findPackageRoot walks up from the test file to a package.json — give it one.
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-vitest-zero-"));
  await atomicWriteFile(
    path.join(tmpRoot, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0" }),
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("runVitestCheck — zero-executed guard (fix 01KV43ET)", () => {
  it("AC1: a marker that matched NO test (all skipped, exit 0) is a FAIL, not a pass — reason names the mismatch", async () => {
    const result = await runVitestCheck(
      0,
      null,
      "drain.workflow.js", // a source-file marker — matches no test name
      "dummy.test.ts",
      tmpRoot,
      makeExecaStub(ALL_SKIPPED, 0),
    );
    expect(runnable(result).status).toBe("fail");
    expect(runnable(result).reason).toMatch(/matched no test|0 ran/i);
    // It must NOT have reported the vacuous "passed".
    expect(runnable(result).reason).not.toMatch(/passed/i);
  });

  it("AC2: a marker that ran a passing test (exit 0) still PASSES (no regression)", async () => {
    const result = await runVitestCheck(
      0,
      null,
      "my real test",
      "dummy.test.ts",
      tmpRoot,
      makeExecaStub(PASSED, 0),
    );
    expect(runnable(result).status).toBe("pass");
  });

  it("a marker that ran some passing tests alongside skips still PASSES", async () => {
    const result = await runVitestCheck(
      0,
      null,
      "my real test",
      "dummy.test.ts",
      tmpRoot,
      makeExecaStub(PASSED_WITH_SOME_SKIPPED, 0),
    );
    expect(runnable(result).status).toBe("pass");
  });

  it("a marker that ran a FAILING test (exit 1) is a FAIL (regression guard)", async () => {
    const result = await runVitestCheck(
      0,
      null,
      "my real test",
      "dummy.test.ts",
      tmpRoot,
      makeExecaStub(FAILED, 1),
    );
    expect(runnable(result).status).toBe("fail");
    expect(runnable(result).reason).toMatch(/failed \(exit 1\)/);
  });

  it("'No test files found' (exit 1) is a FAIL", async () => {
    const result = await runVitestCheck(
      0,
      null,
      "drain.workflow.js",
      "dummy.test.ts",
      tmpRoot,
      makeExecaStub(NO_FILES, 1),
    );
    expect(runnable(result).status).toBe("fail");
  });
});

describe("countExecutedTests — parser unit", () => {
  it("returns 0 when every test is skipped", () => {
    expect(countExecutedTests(ALL_SKIPPED)).toBe(0);
  });
  it("counts passed tests", () => {
    expect(countExecutedTests(PASSED)).toBe(3);
  });
  it("counts passed even when some are skipped", () => {
    expect(countExecutedTests(PASSED_WITH_SOME_SKIPPED)).toBe(2);
  });
  it("counts passed + failed", () => {
    expect(countExecutedTests(FAILED)).toBe(3);
  });
  it("returns 0 for 'No test files found'", () => {
    expect(countExecutedTests(NO_FILES)).toBe(0);
  });
  it("returns 0 for empty output", () => {
    expect(countExecutedTests("")).toBe(0);
  });
  it("does NOT mistake the 'Test Files' line for the 'Tests' line", () => {
    // Only "Test Files 5 passed" present, no "Tests" line → 0 executed.
    expect(countExecutedTests("\n Test Files  5 passed (5)\n")).toBe(0);
  });
  it("strips ANSI colour codes before parsing", () => {
    const colored =
      "\n      Tests  [32m4 passed[39m (4)\n";
    expect(countExecutedTests(colored)).toBe(4);
  });
});
