import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BmadAdapter,
  configureBmadAdapter,
  resetBmadAdapter,
  parseBmadStory,
  reconcileStatus,
} from "../src/adapters/bmad/index.js";
import {
  MalformedBmadStoryError,
  UnknownBmadRefError,
} from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET_REPO = path.join(HERE, "..", "src", "adapters", "bmad", "fixtures", "sample-target-repo");
const MALFORMED_REPO = path.join(HERE, "..", "src", "adapters", "bmad", "fixtures", "sample-malformed-repo");
const STORIES_ROOT = "_bmad-output/planning-artifacts/stories";

function configureTarget() {
  configureBmadAdapter({ targetRepo: TARGET_REPO, storiesRoot: STORIES_ROOT });
}

function configureMalformed() {
  configureBmadAdapter({ targetRepo: MALFORMED_REPO, storiesRoot: STORIES_ROOT });
}

afterEach(() => {
  resetBmadAdapter();
});

describe("BmadAdapter.detect()", () => {
  it("returns true for the happy-path fixture repo (default stories_root matches)", async () => {
    expect(await BmadAdapter.detect(TARGET_REPO)).toBe(true);
  });

  it("matches an ad-hoc tmp repo where the default stories_root has BMad files", async () => {
    // Build an ad-hoc tmp repo at the default path.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bmad-detect-"));
    try {
      const root = path.join(tmp, "_bmad-output", "planning-artifacts", "stories");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, "1-1-foo.md"),
        "# Story 1.1: Foo\n\nStatus: backlog\n\n## Story\n\nAs a user.\n\n## Acceptance Criteria\n\n**AC1:**\n**Given** x.\n",
      );
      expect(await BmadAdapter.detect(tmp)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a repo with no _bmad-output directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bmad-detect-empty-"));
    try {
      expect(await BmadAdapter.detect(tmp)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a repo where stories_root exists but contains no BMad files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bmad-detect-empty-root-"));
    try {
      const root = path.join(tmp, "_bmad-output", "planning-artifacts", "stories");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "README.md"), "no BMad files here\n");
      expect(await BmadAdapter.detect(tmp)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects when stories_root is a file, not a directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bmad-detect-file-"));
    try {
      const root = path.join(tmp, "_bmad-output", "planning-artifacts");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "stories"), "i am not a directory\n");
      expect(await BmadAdapter.detect(tmp)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("BmadAdapter.listSourceStories()", () => {
  beforeEach(() => configureTarget());

  it("returns one SourceStory per non-optional fixture story", async () => {
    const stories = await BmadAdapter.listSourceStories();
    // sample-target-repo has 7 stories; 1 is `optional` → 6 emitted.
    expect(stories.length).toBe(6);
    expect(stories.every((s) => s.raw_frontmatter["status"] !== "optional")).toBe(true);
  });

  it("returns stories in numeric (epic, story) order — 1.10 follows 1.2, not 1.1", async () => {
    const stories = await BmadAdapter.listSourceStories();
    const refs = stories.map((s) => s.ref);
    expect(refs).toEqual([
      "bmad:1.1",
      "bmad:1.2",
      "bmad:1.10",
      "bmad:2.1",
      "bmad:2.2",
      "bmad:2.3",
    ]);
  });

  it("skips stories whose Status is `optional`", async () => {
    const stories = await BmadAdapter.listSourceStories();
    expect(stories.find((s) => s.ref === "bmad:2.4")).toBeUndefined();
  });

  it("populates every required SourceStory field", async () => {
    const stories = await BmadAdapter.listSourceStories();
    for (const s of stories) {
      expect(typeof s.ref).toBe("string");
      expect(typeof s.title).toBe("string");
      expect(typeof s.narrative).toBe("string");
      expect(Array.isArray(s.acceptance_criteria)).toBe(true);
      expect(s.acceptance_criteria.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(s.depends_on)).toBe(true);
      expect(typeof s.raw_path).toBe("string");
      expect(typeof s.raw_frontmatter).toBe("object");
      expect(typeof s.source_hash).toBe("string");
    }
  });

  it("tags ACs as integration|unit|user-surface→integration per the heuristic", async () => {
    const stories = await BmadAdapter.listSourceStories();
    const byRef = new Map(stories.map((s) => [s.ref, s]));

    const s11 = byRef.get("bmad:1.1")!;
    expect(s11.acceptance_criteria[0]!.kind).toBe("unit");

    const s12 = byRef.get("bmad:1.2")!;
    // AC1 is (user-surface) → integration; AC2 is plain → unit.
    expect(s12.acceptance_criteria[0]!.kind).toBe("integration");
    expect(s12.acceptance_criteria[1]!.kind).toBe("unit");
    // HTML comments stripped from the captured text.
    expect(s12.acceptance_criteria[0]!.text).not.toContain("<!--");

    const s21 = byRef.get("bmad:2.1")!;
    expect(s21.acceptance_criteria[0]!.kind).toBe("integration");
  });

  it("normalises depends_on refs from both `bmad:` and filename forms", async () => {
    const stories = await BmadAdapter.listSourceStories();
    const s22 = stories.find((s) => s.ref === "bmad:2.2")!;
    expect(s22.depends_on).toEqual(["bmad:1.1", "bmad:1.2"]);
  });

  it("source_hash is a 64-char hex string and changes when contents change", async () => {
    const stories = await BmadAdapter.listSourceStories();
    const s11 = stories.find((s) => s.ref === "bmad:1.1")!;
    expect(/^[0-9a-f]{64}$/.test(s11.source_hash)).toBe(true);

    // Copy a fixture story to tmp, mutate, re-parse — confirm hash differs.
    const original = await fs.readFile(s11.raw_path, "utf8");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bmad-hash-"));
    try {
      const copyPath = path.join(tmp, "1-1-scaffold-the-thing.md");
      await fs.writeFile(copyPath, original);
      const same = parseBmadStory(copyPath, await fs.readFile(copyPath, "utf8"));
      expect(same.source_hash).toBe(s11.source_hash);

      await fs.writeFile(copyPath, original + "\n<!-- mutated -->\n");
      const diff = parseBmadStory(copyPath, await fs.readFile(copyPath, "utf8"));
      expect(diff.source_hash).not.toBe(s11.source_hash);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("raw_frontmatter carries { status, title, id, filename_slug }", async () => {
    const stories = await BmadAdapter.listSourceStories();
    const s12 = stories.find((s) => s.ref === "bmad:1.2")!;
    expect(s12.raw_frontmatter).toEqual({
      status: "ready-for-dev",
      title: "Add a feature",
      id: "1.2",
      filename_slug: "add-a-feature",
    });
  });
});

describe("BmadAdapter.readSourceStory()", () => {
  it("returns the parsed SourceStory for a known ref against the happy-path repo", async () => {
    configureTarget();
    const story = await BmadAdapter.readSourceStory("bmad:1.1");
    expect(story.ref).toBe("bmad:1.1");
    expect(story.title).toBe("Scaffold the thing");
  });

  it("throws UnknownBmadRefError for a ref with no matching file", async () => {
    configureTarget();
    await expect(BmadAdapter.readSourceStory("bmad:99.99")).rejects.toBeInstanceOf(
      UnknownBmadRefError,
    );
  });

  it("throws UnknownBmadRefError for a malformed ref string", async () => {
    configureTarget();
    await expect(BmadAdapter.readSourceStory("not-a-bmad-ref")).rejects.toBeInstanceOf(
      UnknownBmadRefError,
    );
  });

  it("throws MalformedBmadStoryError for the H1-mismatch fixture", async () => {
    configureMalformed();
    await expect(BmadAdapter.readSourceStory("bmad:2.5")).rejects.toBeInstanceOf(
      MalformedBmadStoryError,
    );
  });

  it("throws MalformedBmadStoryError for the unknown-status fixture", async () => {
    configureMalformed();
    await expect(BmadAdapter.readSourceStory("bmad:2.6")).rejects.toBeInstanceOf(
      MalformedBmadStoryError,
    );
  });
});

describe("BmadAdapter.resolveSourcePath()", () => {
  it("returns the absolute path for a known ref (warm cache via listSourceStories)", async () => {
    configureTarget();
    await BmadAdapter.listSourceStories();
    const p = BmadAdapter.resolveSourcePath("bmad:1.1");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith("1-1-scaffold-the-thing.md")).toBe(true);
  });

  it("works cold (called before listSourceStories on a fresh adapter)", async () => {
    configureTarget();
    const p = BmadAdapter.resolveSourcePath("bmad:2.1");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith("2-1-cross-epic-story.md")).toBe(true);
  });

  it("throws UnknownBmadRefError for an unknown ref", async () => {
    configureTarget();
    expect(() => BmadAdapter.resolveSourcePath("bmad:99.99")).toThrow(
      UnknownBmadRefError,
    );
  });
});

describe("reconcileStatus()", () => {
  const cases: Array<{
    src: string;
    mfst: string;
    expected:
      | { kind: "agree" }
      | { kind: "discrepancy"; severity: "info" | "warn" | "block" };
  }> = [
    { src: "done", mfst: "to-do", expected: { kind: "discrepancy", severity: "warn" } },
    { src: "done", mfst: "in-progress", expected: { kind: "discrepancy", severity: "block" } },
    { src: "done", mfst: "done", expected: { kind: "agree" } },
    { src: "done", mfst: "blocked", expected: { kind: "discrepancy", severity: "block" } },
    { src: "in-progress", mfst: "to-do", expected: { kind: "discrepancy", severity: "info" } },
    { src: "in-progress", mfst: "done", expected: { kind: "discrepancy", severity: "warn" } },
    { src: "in-progress", mfst: "in-progress", expected: { kind: "agree" } },
    { src: "backlog", mfst: "to-do", expected: { kind: "agree" } },
    { src: "ready-for-dev", mfst: "to-do", expected: { kind: "agree" } },
    { src: "ready-for-dev", mfst: "in-progress", expected: { kind: "discrepancy", severity: "info" } },
    { src: "optional", mfst: "to-do", expected: { kind: "agree" } },
    { src: "contexted", mfst: "to-do", expected: { kind: "agree" } },
  ];

  test.each(cases)("source=$src, manifest=$mfst → $expected.kind/$expected.severity", ({ src, mfst, expected }) => {
    const out = reconcileStatus(src, mfst);
    if (expected.kind === "agree") {
      expect(out.kind).toBe("agree");
    } else {
      expect(out.kind).toBe("discrepancy");
      if (out.kind === "discrepancy") {
        expect(out.severity).toBe(expected.severity);
        expect(out.source).toBe(src);
        expect(out.manifest).toBe(mfst);
      }
    }
  });
});
