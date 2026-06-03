import { describe, it, expect } from "vitest";
import { z } from "zod";
import { getActiveAdapter } from "../src/adapters/registry.js";
import {
  AmbiguousAdapterError,
  NoAdapterMatchedError,
  NotImplementedError,
  UnknownAdapterError,
} from "../src/errors.js";
import type { PlanningAdapter, SourceStory } from "../src/adapters/adapter.js";

/**
 * Build a stub `PlanningAdapter` for registry tests.
 *
 * `detectCallCount` is exposed so tests can assert exactly how many times
 * `detect()` was called (verifying the no-short-circuit rule from Story 3.1).
 */
function makeStubAdapter(opts: {
  name: string;
  detectResult: boolean;
}): PlanningAdapter & { detectCallCount: number } {
  let detectCallCount = 0;
  const adapter = {
    get detectCallCount() {
      return detectCallCount;
    },
    name: opts.name,
    async detect(_targetRepo: string): Promise<boolean> {
      detectCallCount++;
      return opts.detectResult;
    },
    async listSourceStories(): Promise<SourceStory[]> {
      return [];
    },
    async readSourceStory(_ref: string): Promise<SourceStory> {
      throw new NotImplementedError("stub");
    },
    resolveSourcePath(_ref: string): string {
      throw new NotImplementedError("stub");
    },
    defaultConfig(): Record<string, unknown> {
      return {};
    },
    adapterConfigSchema: z.record(z.string(), z.unknown()),
    validateAgainstDiscipline(story: SourceStory): SourceStory {
      return story;
    },
  };
  return adapter;
}

describe("getActiveAdapter", () => {
  // ── Branch A: configured adapter name ──────────────────────────────────

  it("AC2 / configured branch — match: returns the matching adapter by reference without calling detect()", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: true });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: true });

    const result = await getActiveAdapter({
      targetRepoRoot: "/tmp/anything",
      configuredAdapterName: "stubB",
      adapters: [stubA, stubB],
    });

    expect(result).toBe(stubB);
    expect(stubA.detectCallCount).toBe(0);
    expect(stubB.detectCallCount).toBe(0);
  });

  it("AC2 / configured branch — unknown name throws UnknownAdapterError", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: false });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: false });

    await expect(
      getActiveAdapter({
        targetRepoRoot: "/tmp/anything",
        configuredAdapterName: "stubMissing",
        adapters: [stubA, stubB],
      }),
    ).rejects.toThrow(UnknownAdapterError);

    try {
      await getActiveAdapter({
        targetRepoRoot: "/tmp/anything",
        configuredAdapterName: "stubMissing",
        adapters: [stubA, stubB],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownAdapterError);
      const e = err as UnknownAdapterError;
      expect(e.configuredAdapterName).toBe("stubMissing");
      expect(e.registeredAdapterNames).toEqual(["stubA", "stubB"]);
      expect(e.message).toContain("stubMissing");
      expect(e.message).toContain("stubA");
    }
  });

  // ── Branch B: no config, run detect() on all ───────────────────────────

  it("AC3 / detect branch — single match wins; all detect() calls are made (no-short-circuit rule)", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: false });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: true });
    const stubC = makeStubAdapter({ name: "stubC", detectResult: false });

    const result = await getActiveAdapter({
      targetRepoRoot: "/tmp/anything",
      adapters: [stubA, stubB, stubC],
    });

    expect(result).toBe(stubB);
    // All three must have been consulted — no early exit on first match.
    expect(stubA.detectCallCount).toBe(1);
    expect(stubB.detectCallCount).toBe(1);
    expect(stubC.detectCallCount).toBe(1);
  });

  it("AC3 / detect branch — ambiguity throws AmbiguousAdapterError in registration order", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: true });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: true });

    await expect(
      getActiveAdapter({
        targetRepoRoot: "/tmp/anything",
        adapters: [stubA, stubB],
      }),
    ).rejects.toThrow(AmbiguousAdapterError);

    try {
      await getActiveAdapter({
        targetRepoRoot: "/tmp/anything",
        adapters: [stubA, stubB],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousAdapterError);
      const e = err as AmbiguousAdapterError;
      // Preserves registration order: stubA before stubB.
      expect(e.matchingAdapters).toEqual(["stubA", "stubB"]);
      expect(e.message).toContain("stubA");
      expect(e.message).toContain("stubB");
    }
  });

  it("detect branch — zero matches throws NoAdapterMatchedError", async () => {
    const stubA = makeStubAdapter({ name: "stubA", detectResult: false });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: false });

    await expect(
      getActiveAdapter({
        targetRepoRoot: "/tmp/anything",
        adapters: [stubA, stubB],
      }),
    ).rejects.toThrow(NoAdapterMatchedError);

    try {
      await getActiveAdapter({
        targetRepoRoot: "/tmp/anything",
        adapters: [stubA, stubB],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NoAdapterMatchedError);
      const e = err as NoAdapterMatchedError;
      expect(e.registeredAdapters).toEqual(["stubA", "stubB"]);
    }
  });
});
