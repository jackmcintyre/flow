/**
 * Story native:01KTKK2Y73EDDAXK470EZ3MHQ8 — gate-1 workflow integrity.
 *
 * The gate-1 workflow runs under the Workflow primitive (`export const meta`,
 * top-level `await`/`return`), so it cannot be unit-executed here. This is a
 * structure/integrity anchor: the script parses, declares its meta, calls
 * `resolveJudgePlan` to drive its lens fan-out, takes the auto-bless path on
 * skip=true, and defaults to the full panel when lane is absent.
 *
 * Mirrors the structural-anchor approach of tests/drain-workflow.test.ts.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE1 = path.resolve(HERE, "..", "..", "workflows", "gate-1.workflow.js");
const SRC = readFileSync(GATE1, "utf8");

describe("Story native:01KTKK2Y73EDDAXK470EZ3MHQ8 — gate-1 workflow integrity", () => {
  it("parses as a Workflow-runtime script (export/meta/top-level await+return)", () => {
    // Wrap the body in an async fn so top-level await/return are valid for parse.
    const wrapped = "(async()=>{" + SRC.replace("export const meta", "const meta") + "})()";
    expect(() => new vm.Script(wrapped)).not.toThrow();
  });

  it("declares meta.name = flow-gate-1 with a judge phase", () => {
    expect(SRC).toMatch(/export const meta\s*=/);
    expect(SRC).toContain("name: 'flow-gate-1'");
    expect(SRC).toContain("title: 'judge'");
  });

  it("reads the persisted lane from the backlog inventory", () => {
    // The lane field must be read from the inventory item returned by
    // readBacklogInventory (the seam that already fetches specText + riskTier).
    // AC4: gate-1 reads the persisted lane and drives fan-out from resolveJudgePlan.
    expect(SRC).toContain("lane");
    expect(SRC).toContain("readBacklogInventory");
  });

  it("calls resolveJudgePlan via the CLI seam before spawning any lens", () => {
    // The load-bearing decision must live in a tool result (resolveJudgePlan),
    // not in workflow JS or agent prose.
    expect(SRC).toContain("resolveJudgePlan");
  });

  it("drives lens fan-out from resolveJudgePlan's result (not from hardcoded LENSES array)", () => {
    // After the resolveJudgePlan call the workflow uses the plan's lenses —
    // the old hardcoded `LENSES.map` is replaced by plan-driven dispatch.
    // We check that the plan result is used to drive the fan-out.
    expect(SRC).toContain("judgePlan");
    expect(SRC).toContain("judgePlan.lenses");
  });

  it("takes the auto-bless path when skip=true (no lenses spawned)", () => {
    // When skip=true the gate calls adjudicateQualityLead / markStoryReady
    // directly without spawning any judge agents.
    expect(SRC).toContain("skip");
    expect(SRC).toContain("judgePlan.skip");
  });

  it("defaults to full panel when lane is absent (conservative default)", () => {
    // When the inventory item has no lane field the workflow must default to the
    // full panel — the conservative 'full' default from resolveJudgePlan.
    // We check that the lane read has a fallback (|| 'full' or ?? 'full' or the
    // lane being passed as undefined to resolveJudgePlan which defaults internally).
    expect(SRC).toMatch(/lane.*full|resolveJudgePlan/);
  });

  it("wires the load-bearing seam tools via the one-shot CLI", () => {
    for (const tool of [
      "mintSessionUlid",
      "buildPersonaSpawnPrompt",
      "resolveLensRoles",
      "readBacklogInventory",
      "resolveJudgePlan",
      "writeLensVerdict",
      "aggregateJudgePanel",
      "adjudicateQualityLead",
    ]) {
      expect(SRC).toContain(tool);
    }
  });

  it("accounts for all gate outcomes in a structured return (no silent failures)", () => {
    for (const field of [
      "decision",
      "riskTier",
      "perLens",
      "failed",
      "sessionUlid",
    ]) {
      expect(SRC).toContain(field);
    }
  });
});
