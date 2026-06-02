/**
 * Deterministic structure test for `plugins/flow/catalogue/planner.md`
 * (Story 3.5 AC6).
 *
 * Loads the planner catalogue prompt from disk and asserts that the `## Prompt`
 * section contains the verbatim strings required by the Discipline validation
 * subsection (Task 7.5). These assertions make the planner-side behavioural
 * contract (AC1–AC3) verifiable without exercising the LLM.
 *
 * Required strings per AC6 / Task 7.5:
 *   - `validatePlannerBacklog` (tool name)
 *   - `missing-integration-ac` (refusal code 1)
 *   - `implicit-depends-on` (refusal code 2)
 *   - `missing-ship-gate` (refusal code 3)
 *   - `state-mutating-without-integration-ac` (refusal code 4, forward-compat)
 */

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// This file lives at:  plugins/flow/mcp-server/src/catalogue/__tests__/planner-prompt-shape.test.ts
// Planner file lives at: plugins/flow/catalogue/planner.md
// Walk up: __tests__ → catalogue → src → mcp-server → crew → plugins → catalogue/planner.md
const PLANNER_PATH = path.resolve(
  HERE,
  "..", // src/catalogue/
  "..", // src/
  "..", // mcp-server/
  "..", // crew/
  "catalogue",
  "planner.md",
);

describe("plugins/flow/catalogue/planner.md structural assertions (Story 3.5 AC6)", () => {
  let content: string;

  it("planner.md exists and is readable", async () => {
    content = await fs.readFile(PLANNER_PATH, "utf8");
    expect(content.length).toBeGreaterThan(100);
  });

  it("## Prompt section exists in the file", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("## Prompt");
  });

  it("contains verbatim string 'validatePlannerBacklog'", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("validatePlannerBacklog");
  });

  it("contains refusal code 'missing-integration-ac'", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("missing-integration-ac");
  });

  it("contains refusal code 'implicit-depends-on'", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("implicit-depends-on");
  });

  it("contains refusal code 'missing-ship-gate'", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("missing-ship-gate");
  });

  it("contains forward-compat refusal code 'state-mutating-without-integration-ac'", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("state-mutating-without-integration-ac");
  });

  it("contains the 'Discipline validation — pre-write check' subsection heading", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("Discipline validation — pre-write check");
  });

  it("contains the verbatim writeNativeStory obligation phrase", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("Before every `writeNativeStory` call, you MUST call `validatePlannerBacklog`");
  });

  it("contains the verbatim refusal preamble phrase", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain(
      "Planning-discipline check refused this story batch. Fix the items below and ask me to retry:",
    );
  });

  it("contains the handoff-guard phrase", async () => {
    const c = await fs.readFile(PLANNER_PATH, "utf8");
    expect(c).toContain("Before emitting the locked handoff phrase, you MUST call `validatePlannerBacklog`");
  });
});
