/**
 * `runProjectBuild` / `runProjectTests` / `runProjectBloatCheck` toolchain
 * integration — Story native:01KVTB3Z.
 *
 * Asserts the dev-side pre-PR gate runners drive the command + cwd derived from
 * the structural toolchain resolver, and that the bloat gate is a NO-OP (skipped,
 * success) when the resolved toolchain has no dead-code check.
 *
 *  - AC1 (external npm repo): runProjectBuild runs `npm run build` at the repo
 *    ROOT; runProjectBloatCheck is SKIPPED (knipCmd null → no subprocess spawned).
 *  - AC4 (Flow repo): runProjectBuild runs `pnpm build` at plugins/flow, purely
 *    from structure.
 *
 * `vitest: plugins/flow/mcp-server/src/lib/__tests__/run-project-build-toolchain.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  runProjectBuild,
  runProjectTests,
  runProjectBloatCheck,
  resolveBuildToolchain,
} from "../run-project-build.js";

function write(p: string, content: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}
function writePkg(dir: string, scripts: Record<string, string>): void {
  write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: path.basename(dir), private: true, scripts }, null, 2),
  );
}

/** A stub execa that records the (cmd, args, cwd) of each call and returns green. */
function makeRecordingExeca(): {
  spy: ReturnType<typeof vi.fn>;
  calls: Array<{ cmd: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const spy = vi.fn(
    async (cmd: string, args: readonly string[], options?: Record<string, unknown>) => {
      calls.push({
        cmd,
        args: [...args],
        cwd: typeof options?.cwd === "string" ? (options.cwd as string) : undefined,
      });
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  );
  return { spy, calls };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "run-build-toolchain-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("AC1 — external npm repo: build/test at repo root, bloat gate SKIPPED", () => {
  beforeEach(() => {
    writePkg(tmp, { build: "tsc", test: "node --test" });
    write(path.join(tmp, "package-lock.json"), "{}\n");
  });

  it("runProjectBuild runs `npm run build` at the repo root", async () => {
    const { spy, calls } = makeRecordingExeca();
    const result = await runProjectBuild({
      devWorkingDir: tmp,
      execaImpl: spy as unknown as Parameters<typeof runProjectBuild>[0]["execaImpl"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(tmp);
    expect(result.commandLine).toBe("npm run build");
    expect(calls[0]).toEqual({ cmd: "npm", args: ["run", "build"], cwd: tmp });
  });

  it("runProjectTests runs `npm run test` at the repo root", async () => {
    const { spy, calls } = makeRecordingExeca();
    const result = await runProjectTests({
      devWorkingDir: tmp,
      execaImpl: spy as unknown as Parameters<typeof runProjectTests>[0]["execaImpl"],
    });
    expect(result.cwd).toBe(tmp);
    expect(calls[0]).toEqual({ cmd: "npm", args: ["run", "test"], cwd: tmp });
  });

  it("runProjectBloatCheck is a NO-OP (skipped, success, no subprocess) when there is no knip", async () => {
    const { spy, calls } = makeRecordingExeca();
    const result = await runProjectBloatCheck({
      devWorkingDir: tmp,
      execaImpl: spy as unknown as Parameters<typeof runProjectBloatCheck>[0]["execaImpl"],
    });
    expect(result.skipped).toBe(true);
    expect(result.exitCode).toBe(0);
    // No subprocess was spawned — the gate short-circuited on knipCmd: null.
    expect(calls).toHaveLength(0);
  });
});

describe("AC4 — Flow repo: build/test at plugins/flow with pnpm, knip runs", () => {
  let flowDir: string;
  beforeEach(() => {
    flowDir = path.join(tmp, "plugins", "flow");
    write(path.join(flowDir, "pnpm-workspace.yaml"), "packages:\n  - mcp-server\n");
    write(path.join(flowDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writePkg(flowDir, { build: "pnpm -r build", test: "pnpm -r test", knip: "knip --no-progress" });
  });

  it("runProjectBuild runs `pnpm build` at plugins/flow purely from structure", async () => {
    const { spy, calls } = makeRecordingExeca();
    const result = await runProjectBuild({
      devWorkingDir: tmp,
      execaImpl: spy as unknown as Parameters<typeof runProjectBuild>[0]["execaImpl"],
    });
    expect(result.cwd).toBe(flowDir);
    expect(result.commandLine).toBe("pnpm build");
    expect(calls[0]).toEqual({ cmd: "pnpm", args: ["build"], cwd: flowDir });
  });

  it("runProjectBloatCheck runs `pnpm knip` (not skipped) when a knip script exists", async () => {
    const { spy, calls } = makeRecordingExeca();
    const result = await runProjectBloatCheck({
      devWorkingDir: tmp,
      execaImpl: spy as unknown as Parameters<typeof runProjectBloatCheck>[0]["execaImpl"],
    });
    expect(result.skipped).toBe(false);
    expect(calls[0]).toEqual({ cmd: "pnpm", args: ["knip"], cwd: flowDir });
  });

  it("resolveBuildToolchain exposes the structural resolution for the Flow repo", () => {
    const tc = resolveBuildToolchain(tmp);
    expect(tc.packageManager).toBe("pnpm");
    expect(tc.cwd).toBe(flowDir);
    expect(tc.source).toBe("workspace");
  });
});
