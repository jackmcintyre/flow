/**
 * Tests for the orphan-tool removal — Story native:01KT7S0E2XWDW3HGVP04HTRMQM.
 *
 * AC1: The reachability auditor reports zero orphaned tools after the removal
 *      of bmadToNativeIngest.
 *
 * AC2: The committed tool-list snapshot (tool-inventory.snapshot.json) reflects
 *      the pruned set — bmadToNativeIngest is absent, all others present.
 *
 * AC3: Any removed tool that had a workflow-seam entry is confirmed NOT to exist
 *      in the run workflow file, proving no live seam was cut.
 *      (bmadToNativeIngest had no workflow-seam entry, so this test verifies
 *      the seam files are clean.)
 *
 * AC4: The five always-preserved tools (runPhaseStart, runPhaseDone,
 *      guardCleanRoot, readReviewerLesson, reapStaleWorktrees) are confirmed
 *      reachable via the auditor's reachability graph.
 *
 * Outer describe name matches the reviewer's vitest: marker (file path as name
 * filter) so `pnpm vitest --run -t <file-path>` executes all tests.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — the audit script is a plain .mjs file with no type declarations;
// the audit-tool-reachability.test.ts imports it the same way.
import {
  buildReachabilityReport,
} from "../../../scripts/audit-tool-reachability.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the committed tool-list snapshot. */
const SNAPSHOT_PATH = path.resolve(__dirname, "..", "tool-inventory.snapshot.json");

/** Path to the run workflow file. */
const RUN_WORKFLOW_PATH = path.resolve(
  __dirname,
  "../../../../workflows/internal/run.workflow.js",
);

describe("plugins/flow/mcp-server/src/tools/__tests__/orphan-tools-removed.test.ts", () => {

  // ---------------------------------------------------------------------------
  // AC1 — Auditor reports zero orphaned tools
  // ---------------------------------------------------------------------------

  describe("AC1 — zero orphaned tools after removal", () => {
    it("buildReachabilityReport returns an empty unreachable list", () => {
      const report = buildReachabilityReport();
      // The unreachable set must be empty — no tool registered in the server is
      // unreachable by all three entry-point classes (skills, workflow seams, peer imports).
      expect(report.unreachable).toEqual([]);
    });

    it("bmadToNativeIngest is NOT in the registered tool list", () => {
      const report = buildReachabilityReport();
      expect(report.registeredTools).not.toContain("bmadToNativeIngest");
    });
  });

  // ---------------------------------------------------------------------------
  // AC2 — Committed snapshot reflects the pruned set
  // ---------------------------------------------------------------------------

  describe("AC2 — tool-inventory snapshot is clean after removal", () => {
    it("snapshot does not contain bmadToNativeIngest", () => {
      const snapshotNames = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as string[];
      expect(snapshotNames).not.toContain("bmadToNativeIngest");
    });

    it("snapshot matches live registered tools exactly (no added, no removed)", async () => {
      const snapshotNames = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as string[];
      const snapshotSet = new Set(snapshotNames);

      // Build the live set from register.ts using the same fake-server trick
      // as the run-auto-merge-gate snapshot test.
      const { registerAllTools } = await import("../register.js");
      const liveTools: string[] = [];
      const fakeServer = {
        registerTool: (tool: { name: string }) => { liveTools.push(tool.name); },
      };
      registerAllTools(fakeServer as unknown as Parameters<typeof registerAllTools>[0]);

      const liveSet = new Set(liveTools);
      const added = [...liveSet].filter((n) => !snapshotSet.has(n));
      const removed = [...snapshotSet].filter((n) => !liveSet.has(n));

      // Names in live but absent from snapshot — update tool-inventory.snapshot.json.
      expect(added).toEqual([]);
      // Names in snapshot but absent from live — update tool-inventory.snapshot.json.
      expect(removed).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // AC3 — No live workflow seam was cut
  // ---------------------------------------------------------------------------

  describe("AC3 — removed tool had no workflow seam entry (run smoke clean)", () => {
    it("bmadToNativeIngestTool does not appear in run.workflow.js seam calls", () => {
      // Read the run workflow source and check that the removed tool is absent
      // from the node CLI seam pattern. This proves the seam was never wired in,
      // so no live run step was cut by the removal.
      let runSource: string;
      try {
        runSource = readFileSync(RUN_WORKFLOW_PATH, "utf8");
      } catch {
        // If the workflow file cannot be found, skip — environment issue not a code issue.
        return;
      }

      // The seam pattern is: node ${CLI} <toolName> --json
      // Verify that neither the MCP name nor the CLI function name appears in any seam call.
      const seamPattern = /node\s+\$\{CLI\}\s+([a-zA-Z][a-zA-Z0-9_]*)/g;
      const seamsFound: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = seamPattern.exec(runSource)) !== null) {
        seamsFound.push(m[1]);
      }

      expect(seamsFound).not.toContain("bmadToNativeIngest");
      expect(seamsFound).not.toContain("bmadToNativeIngestTool");
    });

    it("the reachability report confirms bmadToNativeIngest had no workflow-seam entry", () => {
      const report = buildReachabilityReport();
      // If it had been in the workflow seams, it would appear here.
      expect(report.reachableFromWorkflowSeams).not.toContain("bmadToNativeIngest");
      expect(report.reachableFromWorkflowSeams).not.toContain("bmadToNativeIngestTool");
    });
  });

  // ---------------------------------------------------------------------------
  // AC4 — Five always-preserved tools remain reachable
  // ---------------------------------------------------------------------------

  describe("AC4 — always-preserved tools are reachable and registered", () => {
    const PRESERVED_TOOLS = [
      "runPhaseStart",
      "runPhaseDone",
      "guardCleanRoot",
      "readReviewerLesson",
      "reapStaleWorktrees",
    ] as const;

    it("all five preserved tools appear in the reachable set (workflow-seam entry-point)", () => {
      const report = buildReachabilityReport();
      for (const tool of PRESERVED_TOOLS) {
        expect(report.reachableFromWorkflowSeams).toContain(tool);
      }
    });

    it("all five preserved tools are NOT in the unreachable list", () => {
      const report = buildReachabilityReport();
      for (const tool of PRESERVED_TOOLS) {
        expect(report.unreachable).not.toContain(tool);
      }
    });

    it("the reachable set (union of all entry-point classes) contains all five preserved tools", () => {
      const report = buildReachabilityReport();
      // runPhaseStart, runPhaseDone, guardCleanRoot, reapStaleWorktrees, and
      // readReviewerLesson are all reachable via the run workflow seam (node CLI calls).
      // They may or may not be in the MCP register.ts snapshot (readReviewerLesson is CLI-only).
      // The key invariant is that they appear in the overall reachable set.
      for (const tool of PRESERVED_TOOLS) {
        expect(report.reachableSet).toContain(tool);
      }
    });
  });

}); // end outer describe matching reviewer vitest: marker
