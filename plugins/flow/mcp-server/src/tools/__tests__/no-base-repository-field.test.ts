import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Walk root: plugins/flow/mcp-server/src/
const SRC_ROOT = path.resolve(HERE, "..", "..", "..", "src");

// Directories excluded from the scan (see AC3 rationale).
const EXCLUDE_DIRS = new Set<string>([
  path.resolve(SRC_ROOT, "tools", "__tests__"),
  path.resolve(SRC_ROOT, "__tests__", "test-helpers"),
]);

async function walkTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(full)) continue;
      out.push(...(await walkTsFiles(full)));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("guard: no `gh pr view ... baseRepository` references remain", () => {
  it("finds zero offenders under plugins/flow/mcp-server/src/", async () => {
    const files = await walkTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf-8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        if (line.includes("gh pr view") && line.includes("baseRepository")) {
          offenders.push(`${file}:${idx + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Found ${offenders.length} offending line(s):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
