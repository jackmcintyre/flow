import { describe, expect, it, vi } from "vitest";
import { gitCommit } from "../src/lib/git.js";
import { GitCommitMessageMalformedError } from "../src/errors.js";

type ExecaArgs = [string, readonly string[]];

interface ExecaStubResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function makeExecaSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(async (cmd: string, args: readonly string[]): Promise<ExecaStubResult> => {
    expect(cmd).toBe("git");
    const subcmd = args[2];
    if (subcmd === "add") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (subcmd === "commit") {
      return {
        stdout: "[main 0123abc] regenerate-standards: bmad:1.2.3",
        stderr: "",
        exitCode: 0,
      };
    }
    if (subcmd === "rev-parse") {
      return {
        stdout: "0123abcdef0123abcdef0123abcdef0123abcdef\n",
        stderr: "",
        exitCode: 0,
      };
    }
    throw new Error(`Unexpected git subcommand: ${subcmd}`);
  });
}

describe("gitCommit — happy path (AC6d)", () => {
  it("runs add, commit, rev-parse in order and returns the harvested SHA", async () => {
    const spy = makeExecaSpy();

    const result = await gitCommit({
      targetRepoRoot: "/tmp/fake",
      paths: ["docs/standards.md"],
      message: "regenerate-standards: bmad:1.2.3",
      role: "generalist-dev",
      execaImpl: spy as unknown as Parameters<typeof gitCommit>[0]["execaImpl"],
    });

    expect(spy).toHaveBeenCalledTimes(3);

    const calls = spy.mock.calls as unknown as ExecaArgs[];
    expect(calls[0]).toEqual(["git", ["-C", "/tmp/fake", "add", "docs/standards.md"]]);
    expect(calls[1]).toEqual([
      "git",
      ["-C", "/tmp/fake", "commit", "-m", "regenerate-standards: bmad:1.2.3"],
    ]);
    expect(calls[2]).toEqual(["git", ["-C", "/tmp/fake", "rev-parse", "HEAD"]]);

    expect(result.commitSha).toBe("0123abcdef0123abcdef0123abcdef0123abcdef");
    expect(result.stdout).toBe("[main 0123abc] regenerate-standards: bmad:1.2.3");
    expect(result.stderr).toBe("");
  });
});

describe("gitCommit — refused before spawn (AC6e)", () => {
  it("throws GitCommitMessageMalformedError for a malformed message and does NOT spawn", async () => {
    const spy = vi.fn();
    await expect(
      gitCommit({
        targetRepoRoot: "/tmp/fake",
        paths: ["docs/standards.md"],
        message: "no colon here",
        role: "generalist-dev",
        execaImpl: spy as unknown as Parameters<typeof gitCommit>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GitCommitMessageMalformedError);

    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("throws GitCommitMessageMalformedError for empty paths and does NOT spawn", async () => {
    const spy = vi.fn();
    await expect(
      gitCommit({
        targetRepoRoot: "/tmp/fake",
        paths: [],
        message: "valid: ref",
        role: "generalist-dev",
        execaImpl: spy as unknown as Parameters<typeof gitCommit>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GitCommitMessageMalformedError);

    expect(spy).toHaveBeenCalledTimes(0);
  });
});
