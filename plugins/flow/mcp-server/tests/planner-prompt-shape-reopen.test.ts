/**
 * Story 3.6 AC5 — planner-prompt-shape test for the re-open mode subsection.
 *
 * Loads `plugins/flow/catalogue/planner.md` from disk and asserts that every
 * literal string required by AC5 / Task 2.2 is present in the `## Prompt`
 * section. This is a deterministic grep-style test — it does not exercise the
 * LLM; it asserts the structural prompt-level contract.
 *
 * The literal strings below are verbatim from the story's AC5 requirements:
 *   - The `### Re-open mode — backlog review and discard flow` heading.
 *   - The `markWithdrawn` tool name.
 *   - The `revert/deprecate: ` title prefix.
 *   - The in-progress refusal string.
 *   - The edit-pending BMad refusal string.
 *   - The external-adapter reminder string.
 *   - The three action-menu labels.
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLANNER_MD = path.resolve(HERE, "..", "..", "catalogue", "planner.md");

async function getPlannerPromptSection(): Promise<string> {
  const raw = await fs.readFile(PLANNER_MD, "utf8");
  // Extract the ## Prompt section (everything after "## Prompt" up to the next "## " or EOF).
  const promptIdx = raw.indexOf("## Prompt");
  if (promptIdx === -1) throw new Error("planner.md is missing ## Prompt section");
  return raw.slice(promptIdx);
}

describe("Story 3.6 AC5 — planner prompt re-open mode subsection", () => {
  it("contains the ### Re-open mode heading (AC5 anchor)", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain("### Re-open mode — backlog review and discard flow");
  });

  it("names the markWithdrawn MCP tool as the external-adapter discard primitive", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain("markWithdrawn");
  });

  it("names the revert/deprecate: title prefix as the native-adapter discard story shape", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain("revert/deprecate: ");
  });

  it("enumerates the in-progress refusal string verbatim", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain(
      '"Story <ref> is in-progress and cannot be edited. Wait for it to land in done/ or blocked/, or discard it instead."',
    );
  });

  it("enumerates the edit-pending BMad refusal string verbatim", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain(
      '"Edit-pending is native-only in v1. Edit the source story in <adapter-name> and run /flow:plan to materialise the changes."',
    );
  });

  it("enumerates the external-adapter reminder string verbatim", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain(
      '"Manifest marked withdrawn. Close the source story in <adapter-name> manually — the plugin cannot edit the source tool\'s tree."',
    );
  });

  it("contains the add action-menu label", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain("1. add — author a new story");
  });

  it("contains the edit-pending action-menu label", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain("2. edit-pending — rewrite a story currently in to-do/");
  });

  it("contains the discard action-menu label", async () => {
    const prompt = await getPlannerPromptSection();
    expect(prompt).toContain("3. discard — withdraw a feature (built or pending)");
  });
});
