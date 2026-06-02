/**
 * Story 2.4 Task 2.2 — unit tests for the pure repo-signal helpers.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric. These helpers are internal — no user-surface coverage here.
 */
import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectDependencyManifests,
  detectLanguagesFromLayout,
  truncateReadmeExcerpt,
} from "../src/lib/repo-signal-detectors.js";
import { readRepoSignals } from "../src/tools/read-repo-signals.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { await fs.rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
async function makeTmp(prefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `crew-repo-signals-${prefix}-`));
  tmpDirs.push(tmp);
  return tmp;
}

describe("detectLanguagesFromLayout", () => {
  it("TS-only layout returns sorted [Markdown, TypeScript]", () => {
    const langs = detectLanguagesFromLayout([
      "package.json",
      "tsconfig.json",
      "README.md",
    ]);
    expect(langs).toEqual(["Markdown", "TypeScript"]);
  });

  it("Python layout with pyproject.toml returns [Python]", () => {
    expect(detectLanguagesFromLayout(["pyproject.toml", "src"])).toEqual([
      "Python",
    ]);
  });

  it("mixed layout returns sorted union", () => {
    const langs = detectLanguagesFromLayout([
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
      "README.md",
    ]);
    expect(langs).toEqual(["Markdown", "Python", "Rust", "TypeScript"]);
  });

  it("empty entries returns []", () => {
    expect(detectLanguagesFromLayout([])).toEqual([]);
  });
});

describe("detectDependencyManifests", () => {
  it("returns intersection with canonical manifest filenames, sorted", () => {
    expect(
      detectDependencyManifests([
        "src",
        "package.json",
        "pyproject.toml",
        "README.md",
      ]),
    ).toEqual(["package.json", "pyproject.toml"]);
  });

  it("empty input returns []", () => {
    expect(detectDependencyManifests([])).toEqual([]);
  });
});

describe("truncateReadmeExcerpt", () => {
  it("truncates long input to 501 chars ending in '…'", () => {
    const out = truncateReadmeExcerpt("a".repeat(600));
    expect(out.length).toBe(501);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns short input unchanged", () => {
    expect(truncateReadmeExcerpt("short")).toBe("short");
  });

  it("trims trailing whitespace before truncation check", () => {
    expect(truncateReadmeExcerpt("hello   \n\n")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Bug 3 fix — depth-1 monorepo fallback in readRepoSignals
// ---------------------------------------------------------------------------
describe("readRepoSignals — depth-1 monorepo fallback", () => {
  it("detects TypeScript when package.json lives under src/ with no root manifest", async () => {
    const root = await makeTmp("monorepo");
    // No root package.json — only src/package.json (common monorepo layout).
    const srcDir = path.join(root, "src");
    await fs.mkdir(srcDir);
    await fs.writeFile(path.join(srcDir, "package.json"), '{"name":"test"}', "utf8");

    const signals = await readRepoSignals({ targetRepoRoot: root });
    expect(signals.languages).toContain("TypeScript");
  });

  it("still detects languages from root when root has manifests", async () => {
    const root = await makeTmp("root-manifest");
    await fs.writeFile(path.join(root, "package.json"), '{"name":"test"}', "utf8");

    const signals = await readRepoSignals({ targetRepoRoot: root });
    expect(signals.languages).toContain("TypeScript");
  });
});
