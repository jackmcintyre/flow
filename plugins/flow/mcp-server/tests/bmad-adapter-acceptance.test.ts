import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "../..");
const SPIKE_PATH = resolve(PLUGIN_ROOT, "docs/spikes/bmad-format.md");

// ---------------------------------------------------------------------------
// Story 3.3 AC1: BMad-format spike report exists and enumerates the four
// required dimensions (frontmatter fields, lifecycle vocabulary, dependency
// syntax — plus the source-file location convention the adapter relies on).
// ---------------------------------------------------------------------------
describe("Story 3.3 AC1 — BMad-format spike report", () => {
  it("spike file exists at plugins/<plugin>/docs/spikes/bmad-format.md", () => {
    expect(existsSync(SPIKE_PATH), `missing ${SPIKE_PATH}`).toBe(true);
  });

  it("enumerates frontmatter fields, lifecycle vocabulary, and dependency syntax", () => {
    const text = readFileSync(SPIKE_PATH, "utf8");
    // Required sections per AC1 (verbatim sub-topics):
    const requiredSections = [
      "## Frontmatter fields",
      "## Lifecycle vocabulary",
      "## Dependency syntax",
      "## Acceptance criteria shape",
    ];
    for (const heading of requiredSections) {
      expect(
        text.includes(heading),
        `spike doc missing required section: ${heading}`,
      ).toBe(true);
    }
  });
});
