/**
 * Drain inline-spec-to-builder test
 * Story native:01KT6QGBWP7KJDVMHQK3MEKDXP (AC2)
 *
 * Verifies that when the drain orchestrator claims a native story, it:
 *   AC2-a: calls the `readManifestAcs` seam to extract the story's ACs from
 *          the orchestrator's manifest (where `.flow/` is present).
 *   AC2-b: passes the extracted ACs as `inlineAcs` in the `runDevTerminalAction`
 *          args embedded in the builder's prompt — so the builder's own
 *          file-read of the spec is not required to proceed.
 *   AC2-c: does NOT embed `inlineAcs` for non-native (BMad) stories (backward
 *          compatible: the BMad file-read path is unchanged).
 *
 * How it runs the real workflow: same AsyncFunction wrapping pattern as
 * drain-exec-model.test.ts — the drain script uses injected globals only.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "../../../../workflows/drain.workflow.js");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

interface AgentCall {
  prompt: string;
  opts: { label?: string; schema?: unknown; phase?: string; model?: string; isolation?: string };
}

const NATIVE_REF = "native:01KTEST0INLINE0000000000";
const BMAD_REF = "bmad:1.1";
const PR = 5599;

const FAKE_ACS = [
  { index: 1, firstLine: "Given a native story, When the drain runs, Then the builder has ACs.", tag: "integration", body: ["Given a native story, When the drain runs, Then the builder has ACs."] },
  { index: 2, firstLine: "Given a drain run, When the orchestrator prepares context, Then ACs are passed inline.", tag: null, body: ["Given a drain run, When the orchestrator prepares context, Then ACs are passed inline."] },
];

/**
 * Drive the real drain workflow with stubbed seams; returns captured calls.
 */
async function runDrainForRef(ref: string): Promise<{
  result: any;
  thrown: unknown;
  calls: AgentCall[];
  seamLabels: string[];
}> {
  const source = readFileSync(WORKFLOW_PATH, "utf8").replace(
    /^export\s+const\s+meta\b/m,
    "const meta",
  );
  const body = `${source}\n//# sourceURL=drain.workflow.js`;

  const calls: AgentCall[] = [];
  const seamLabels: string[] = [];

  const seamResult = (label: string): unknown => {
    if (label === "mint") return { sessionUlid: "01TESTULID0000000000000000" };
    if (label.startsWith("persona:dev")) return { systemPrompt: "DEV-PERSONA" };
    if (label.startsWith("persona:reviewer")) return { systemPrompt: "REV-PERSONA" };
    if (label === "worktree-reap") return { reaped: [] };
    if (label === "orphan-scan") return { orphans: [] };
    if (label.startsWith("claim:")) {
      const idx = Number(label.split(":")[1]);
      if (idx === 0) {
        return {
          next: "spawn-dev",
          ref,
          title: "Inline spec to builder",
          manifestPath: "/fake/path/.flow/state/in-progress/" + ref + ".yaml",
        };
      }
      return { next: "queue-drained" };
    }
    // readManifestAcs seam (AC2-a): return the stubbed ACs for native stories.
    if (label.startsWith("read-acs:")) {
      return { acs: FAKE_ACS };
    }
    if (label.startsWith("build-plan:")) {
      return { devReviewerModel: "sonnet", reviewDepth: "full" };
    }
    if (label.startsWith("pd:")) {
      return { next: "spawn-reviewer", prNumber: PR, reviewerPrompt: "REV-PERSONA" };
    }
    if (label.startsWith("verdict:")) return { next: "done-ready-for-merge" };
    if (label.startsWith("gate:")) {
      return { decision: "pause-needs-human", reason: "no-agreement-history" };
    }
    if (label.startsWith("progress-start:")) return { atMs: 0, line: `${ref} phase: start` };
    if (label.startsWith("progress-done:")) return { line: `${ref} phase: done (0ms)` };
    if (label.startsWith("clean-root-guard:")) return { dirty: false, paths: [] };
    if (label.startsWith("lesson-read:")) return { lesson: null };
    return { _unstubbed: label };
  };

  const agent = async (prompt: string, agentOpts: AgentCall["opts"] = {}) => {
    calls.push({ prompt, opts: agentOpts });
    const label = agentOpts.label ?? "";

    if (agentOpts.schema) {
      seamLabels.push(label);
      return { stdout: JSON.stringify(seamResult(label)) };
    }
    if (label.startsWith("dev:")) {
      return `Implemented the story.\nHandoff to reviewer — story ${ref} ready for review.`;
    }
    if (label.startsWith("rev:")) {
      return "Reviewed; verdict written to reviewer-result.json.";
    }
    return "";
  };

  const log = (_line: string) => { /* no-op */ };
  const phase = (_name: string) => { /* no-op */ };

  const args = JSON.stringify({
    targetRepoRoot: "/tmp/target-repo",
    cli: "/tmp/cli.js",
    sessionUlid: "01TESTULID0000000000000000",
    maxConcurrency: 1,
    repollDelayMs: 0,
  });

  const fn = new AsyncFunction("args", "agent", "log", "phase", body);
  let result: any;
  let thrown: unknown = undefined;
  try {
    result = await fn(args, agent, log, phase);
  } catch (e) {
    thrown = e;
  }
  return { result, thrown, calls, seamLabels };
}

describe("drain inline-spec-to-builder (Story native:01KT6QGBWP7KJDVMHQK3MEKDXP)", () => {
  describe("AC2: native story — orchestrator extracts ACs and passes inline to builder", () => {
    it("AC2-a: calls the readManifestAcs seam for a native story ref", async () => {
      const { thrown, seamLabels } = await runDrainForRef(NATIVE_REF);

      expect(thrown).toBeUndefined();

      // The drain must have called the read-acs seam for this native ref.
      const readAcsLabel = seamLabels.find((l) => l.startsWith("read-acs:"));
      expect(readAcsLabel, "readManifestAcs seam was not called for native story").toBeDefined();
      expect(readAcsLabel).toContain(NATIVE_REF);
    });

    it("AC2-b: embeds inlineAcs in the runDevTerminalAction args in the builder prompt", async () => {
      const { thrown, calls } = await runDrainForRef(NATIVE_REF);

      expect(thrown).toBeUndefined();

      // Find the dev: agent call (direct call, no schema).
      const devCall = calls.find(
        (c) => !c.opts.schema && c.opts.label?.startsWith("dev:"),
      );
      expect(devCall, "dev: agent call not found").toBeDefined();

      const prompt = devCall!.prompt;

      // The prompt must embed 'inlineAcs' in the runDevTerminalAction JSON args.
      expect(prompt).toContain("inlineAcs");

      // The embedded JSON must include the first AC's firstLine text to confirm
      // it's the real extracted content, not a placeholder.
      expect(prompt).toContain(FAKE_ACS[0]!.firstLine);
    });

    it("AC2-b: the builder's own file-read of the spec is not required — inlineAcs is present in the runDevTerminalAction call", async () => {
      const { thrown, calls } = await runDrainForRef(NATIVE_REF);

      expect(thrown).toBeUndefined();

      const devCall = calls.find(
        (c) => !c.opts.schema && c.opts.label?.startsWith("dev:"),
      );
      expect(devCall).toBeDefined();
      const prompt = devCall!.prompt;

      // Extract the runDevTerminalAction JSON from the prompt.
      // The JSON follows `--json '` and ends before the closing `'`.
      const jsonMatch = prompt.match(/runDevTerminalAction --json '(\{[^']+\})'/);
      expect(jsonMatch, "runDevTerminalAction --json block not found in prompt").toBeDefined();

      const parsedArgs = JSON.parse(jsonMatch![1]!);
      expect(Array.isArray(parsedArgs.inlineAcs), "inlineAcs must be an array in the runDevTerminalAction args").toBe(true);
      expect(parsedArgs.inlineAcs).toHaveLength(FAKE_ACS.length);
      expect(parsedArgs.inlineAcs[0].index).toBe(1);
    });
  });

  describe("AC2-c: non-native (BMad) story — no readManifestAcs seam call, no inlineAcs", () => {
    it("does NOT call readManifestAcs for a BMad story", async () => {
      const { thrown, seamLabels } = await runDrainForRef(BMAD_REF);

      expect(thrown).toBeUndefined();

      // No read-acs seam should be called for a non-native story.
      const readAcsLabel = seamLabels.find((l) => l.startsWith("read-acs:"));
      expect(readAcsLabel, "readManifestAcs seam must NOT be called for BMad story").toBeUndefined();
    });

    it("does NOT embed inlineAcs in the builder prompt for a BMad story", async () => {
      const { thrown, calls } = await runDrainForRef(BMAD_REF);

      expect(thrown).toBeUndefined();

      const devCall = calls.find(
        (c) => !c.opts.schema && c.opts.label?.startsWith("dev:"),
      );
      expect(devCall, "dev: agent call not found").toBeDefined();

      const prompt = devCall!.prompt;

      // For BMad stories, inlineAcs must NOT appear in the prompt at all.
      expect(prompt).not.toContain("inlineAcs");
    });
  });
});
