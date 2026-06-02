/**
 * Acceptance suite for Story 3.1 — PlanningAdapter interface and adapter registry.
 *
 * AC1: adapter.ts declares name, detect, listSourceStories, readSourceStory,
 *      resolveSourcePath, optional watchForChanges, and validateAgainstDiscipline.
 * AC2: registry reads adapter: from workspace config and returns matching adapter
 *      or throws UnknownAdapterError.
 * AC3: no adapter: key → detect() across all adapters; first-match or AmbiguousAdapterError.
 * AC4: vitest covers configured / detected / ambiguous branches via two stub adapters.
 */

import { describe, it, expect } from "vitest";
import type { PlanningAdapter, SourceStory, DisciplineViolation } from "../src/adapters/adapter.js";
import { getActiveAdapter } from "../src/adapters/registry.js";
import {
  UnknownAdapterError,
  AmbiguousAdapterError,
  NoAdapterMatchedError,
} from "../src/errors.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers — two minimal stub adapters used throughout
// ---------------------------------------------------------------------------

function makeStub(
  name: string,
  detectResult: boolean,
): PlanningAdapter {
  return {
    name,
    detect: async (_repo: string) => detectResult,
    listSourceStories: async () => [],
    readSourceStory: async (ref: string): Promise<SourceStory> => {
      throw new Error(`stub: readSourceStory not implemented (${ref})`);
    },
    resolveSourcePath: (ref: string) => `/stub/${name}/${ref}`,
    validateAgainstDiscipline: (story: SourceStory): SourceStory | DisciplineViolation =>
      story,
    defaultConfig: () => ({}),
    adapterConfigSchema: z.object({}),
  };
}

const stubAlpha = makeStub("stub-alpha", false);
const stubBeta = makeStub("stub-beta", false);

function detectingStub(name: string): PlanningAdapter {
  return makeStub(name, true);
}

// ---------------------------------------------------------------------------
// AC1 — Interface shape
// ---------------------------------------------------------------------------

describe("AC1 – PlanningAdapter interface declares all required members", () => {
  it("has a name string", () => {
    expect(typeof stubAlpha.name).toBe("string");
  });

  it("has detect() that returns Promise<boolean>", async () => {
    const result = await stubAlpha.detect("/any");
    expect(typeof result).toBe("boolean");
  });

  it("has listSourceStories() that returns Promise<SourceStory[]>", async () => {
    const result = await stubAlpha.listSourceStories();
    expect(Array.isArray(result)).toBe(true);
  });

  it("has readSourceStory() that returns Promise<SourceStory>", () => {
    // method exists and is a function — runtime behavior is stub-specific
    expect(typeof stubAlpha.readSourceStory).toBe("function");
  });

  it("has resolveSourcePath() that returns a string", () => {
    const result = stubAlpha.resolveSourcePath("my-story");
    expect(typeof result).toBe("string");
  });

  it("watchForChanges is optional (may be undefined on a conforming adapter)", () => {
    // The interface marks it as optional; a stub that omits it is still conformant.
    expect(stubAlpha.watchForChanges).toBeUndefined();
  });

  it("has validateAgainstDiscipline() that accepts a SourceStory", () => {
    const story: SourceStory = {
      ref: "s-1",
      title: "Test story",
      narrative: "As a user",
      acceptance_criteria: [],
      depends_on: [],
      raw_path: "/tmp/s-1.md",
      raw_frontmatter: {},
      source_hash: "abc123",
    };
    const result = stubAlpha.validateAgainstDiscipline(story);
    // Pass-through stub returns the story unchanged
    expect(result).toBe(story);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Branch A: configuredAdapterName provided
// ---------------------------------------------------------------------------

describe("AC2 – registry with adapter: in config", () => {
  it("returns the matching adapter when configuredAdapterName matches a registered adapter", async () => {
    const adapter = await getActiveAdapter({
      targetRepoRoot: "/fake/repo",
      configuredAdapterName: "stub-alpha",
      adapters: [stubAlpha, stubBeta],
    });
    expect(adapter.name).toBe("stub-alpha");
  });

  it("throws UnknownAdapterError when configuredAdapterName does not match any registered adapter", async () => {
    await expect(
      getActiveAdapter({
        targetRepoRoot: "/fake/repo",
        configuredAdapterName: "nonexistent-adapter",
        adapters: [stubAlpha, stubBeta],
      }),
    ).rejects.toThrow(UnknownAdapterError);
  });

  it("UnknownAdapterError carries the configured name and registered names", async () => {
    let caught: UnknownAdapterError | undefined;
    try {
      await getActiveAdapter({
        targetRepoRoot: "/fake/repo",
        configuredAdapterName: "nonexistent-adapter",
        adapters: [stubAlpha, stubBeta],
      });
    } catch (e) {
      caught = e as UnknownAdapterError;
    }
    expect(caught).toBeInstanceOf(UnknownAdapterError);
    expect(caught?.configuredAdapterName).toBe("nonexistent-adapter");
    expect(caught?.registeredAdapterNames).toEqual(["stub-alpha", "stub-beta"]);
  });

  it("does NOT call detect() when configuredAdapterName is provided", async () => {
    let detectCalled = false;
    const spyAdapter: PlanningAdapter = {
      ...stubAlpha,
      detect: async (_repo) => {
        detectCalled = true;
        return true;
      },
    };
    await getActiveAdapter({
      targetRepoRoot: "/fake/repo",
      configuredAdapterName: "stub-alpha",
      adapters: [spyAdapter, stubBeta],
    });
    expect(detectCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Branch B: no adapter: in config — detect() runs across all adapters
// ---------------------------------------------------------------------------

describe("AC3 – registry without adapter: in config (auto-detect)", () => {
  it("returns the sole matching adapter when exactly one detect() is true", async () => {
    const alpha = detectingStub("stub-alpha");
    const beta = makeStub("stub-beta", false);

    const adapter = await getActiveAdapter({
      targetRepoRoot: "/fake/repo",
      adapters: [alpha, beta],
    });
    expect(adapter.name).toBe("stub-alpha");
  });

  it("throws AmbiguousAdapterError when two or more detect() calls return true", async () => {
    const alpha = detectingStub("stub-alpha");
    const beta = detectingStub("stub-beta");

    await expect(
      getActiveAdapter({
        targetRepoRoot: "/fake/repo",
        adapters: [alpha, beta],
      }),
    ).rejects.toThrow(AmbiguousAdapterError);
  });

  it("AmbiguousAdapterError lists both matching adapter names in registration order", async () => {
    const alpha = detectingStub("stub-alpha");
    const beta = detectingStub("stub-beta");

    let caught: AmbiguousAdapterError | undefined;
    try {
      await getActiveAdapter({
        targetRepoRoot: "/fake/repo",
        adapters: [alpha, beta],
      });
    } catch (e) {
      caught = e as AmbiguousAdapterError;
    }
    expect(caught).toBeInstanceOf(AmbiguousAdapterError);
    expect(caught?.matchingAdapters).toEqual(["stub-alpha", "stub-beta"]);
  });

  it("throws NoAdapterMatchedError when no detect() returns true", async () => {
    await expect(
      getActiveAdapter({
        targetRepoRoot: "/fake/repo",
        adapters: [stubAlpha, stubBeta],
      }),
    ).rejects.toThrow(NoAdapterMatchedError);
  });

  it("calls detect() on ALL registered adapters before evaluating the result (no short-circuit)", async () => {
    const calls: string[] = [];
    const a: PlanningAdapter = {
      ...detectingStub("a"),
      detect: async (repo) => { calls.push("a"); return true; },
    };
    const b: PlanningAdapter = {
      ...makeStub("b", false),
      detect: async (repo) => { calls.push("b"); return false; },
    };

    // Even though 'a' matches, 'b' must still be consulted
    await getActiveAdapter({ targetRepoRoot: "/fake/repo", adapters: [a, b] });
    expect(calls).toContain("a");
    expect(calls).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// AC4 — Integration: all three branches covered using two stub adapters
// ---------------------------------------------------------------------------

describe("AC4 – integration: three branches covered with two stub adapters", () => {
  it("Branch A (configured): resolves correctly", async () => {
    const adapter = await getActiveAdapter({
      targetRepoRoot: "/repo",
      configuredAdapterName: "stub-beta",
      adapters: [stubAlpha, stubBeta],
    });
    expect(adapter.name).toBe("stub-beta");
  });

  it("Branch B (detected): returns sole match", async () => {
    const detectingAlpha = detectingStub("stub-alpha");
    const nonMatchingBeta = makeStub("stub-beta", false);

    const adapter = await getActiveAdapter({
      targetRepoRoot: "/repo",
      adapters: [detectingAlpha, nonMatchingBeta],
    });
    expect(adapter.name).toBe("stub-alpha");
  });

  it("Branch B (ambiguous): raises AmbiguousAdapterError", async () => {
    const detectingAlpha = detectingStub("stub-alpha");
    const detectingBeta = detectingStub("stub-beta");

    await expect(
      getActiveAdapter({
        targetRepoRoot: "/repo",
        adapters: [detectingAlpha, detectingBeta],
      }),
    ).rejects.toBeInstanceOf(AmbiguousAdapterError);
  });
});
