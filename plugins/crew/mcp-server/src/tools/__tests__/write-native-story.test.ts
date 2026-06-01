/**
 * Integration tests for `writeNativeStory` — Story 9.2 (Epic 9 author seam).
 *
 * Focus: the FAIL-CLOSED discipline gate (AC1). The discipline validator now
 * runs INSIDE the write tool, before any filesystem write. A candidate that
 * violates an authoring-time discipline rule is refused with a typed
 * `DisciplineViolationError` carrying the violation code(s), and NO
 * native-story file appears on disk — even on a direct write that never went
 * through the planner's pre-write `validatePlannerBacklog` step.
 *
 * Fixture pattern mirrors scan-sources.test.ts / mark-story-ready.test.ts:
 * a minimal native-adapter workspace (config.yaml + native-stories dir) in a
 * fresh tmpdir, with writes routed through the canonical `atomicWriteFile`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { DisciplineViolationError } from "../../errors.js";
import { writeNativeStory } from "../write-native-story.js";
import { parseNativeStory } from "../../adapters/native/parse-native-story.js";

let root: string;
let storiesDir: string;

async function listStoryFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(storiesDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * Seed a repo-relative file under `root` so a Story 10.3 T0-5/T0-6 resolvability
 * check (cited sources / `artifact:` targets must resolve at write time) passes.
 */
async function seedFile(relPath: string): Promise<void> {
  // Route the write through the sanctioned atomicWriteFile seam so the static
  // fs-write guard (canonical-fs-guard.test.ts) does not flag this test file
  // for a raw write binding. The path is non-canonical (outside .crew/state/**)
  // so no MCP tool context is required.
  await atomicWriteFile(path.join(root, relPath), "// seeded for resolvability\n");
}

beforeEach(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crew-write-native-story-"));
  root = path.join(scratch, "workspace");
  storiesDir = path.join(root, ".crew", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  // Native-adapter config so resolveWorkspace picks the native adapter.
  await atomicWriteFile(
    path.join(root, ".crew", "config.yaml"),
    `adapter: native\nadapter_config: {}\n`,
  );
  // Story 10.3 — the write-time gate now resolves cited sources and `artifact:`
  // verification targets on disk. Seed every path the passing-candidate fixtures
  // below cite or reference as an artifact so those writes are not (correctly)
  // rejected as unresolvable. `vitest:` targets are NOT seeded — they are
  // shape-checked only (the build creates the test file).
  for (const rel of [
    "src/state/ledger.ts",
    "src/ui/greeting.ts",
    "src/feature/index.ts",
    "src/parser.ts",
    "docs/design.md",
    "build/out/report.json",
    "build/out.json",
  ]) {
    await seedFile(rel);
  }
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — the write path is fail-closed on discipline
// ---------------------------------------------------------------------------

describe("writeNativeStory AC1 — fail-closed discipline gate", () => {
  it("refuses a state-mutating candidate that lacks an integration AC, with a typed error and no file written", async () => {
    // State-mutating heuristic fires on a path-glob token like
    // `.crew/state/<ref>.yaml` / `sprint-status.yaml`. This candidate names one
    // but tags its only AC `unit`, so the missing-integration-ac rule must fire.
    const promise = writeNativeStory({
      targetRepoRoot: root,
      title: "Persist the backlog ledger",
      narrative: {
        role: "operator",
        want: "the plugin to write sprint-status.yaml",
        so_that: "the backlog ledger is durable",
      },
      acceptance_criteria: [
        {
          text: "**Given** a backlog, **When** the operator runs it, **Then** sprint-status.yaml is updated.",
          kind: "unit",
          verification: { type: "vitest", target: "src/__tests__/ledger.test.ts" },
        },
      ],
      tasks: [{ text: "Write the ledger path", ac_refs: ["AC1"] }],
      cited_sources: ["src/state/ledger.ts"],
      depends_on: [],
    });

    await expect(promise).rejects.toBeInstanceOf(DisciplineViolationError);

    // The typed error carries the violation code(s).
    let caught: unknown;
    try {
      await writeNativeStory({
        targetRepoRoot: root,
        title: "Persist the backlog ledger",
        narrative: {
          role: "operator",
          want: "the plugin to write sprint-status.yaml",
          so_that: "the backlog ledger is durable",
        },
        acceptance_criteria: [
          {
            text: "Given a backlog, When the operator runs it, Then sprint-status.yaml is updated.",
            kind: "unit",
            verification: { type: "vitest", target: "src/__tests__/ledger.test.ts" },
          },
        ],
        tasks: [{ text: "Write the ledger path", ac_refs: ["AC1"] }],
        cited_sources: ["src/state/ledger.ts"],
        depends_on: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("missing-integration-ac");

    // No native-story file appears on disk.
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("writes a passing candidate (state-mutating WITH an integration AC) and returns its ref + path", async () => {
    const result = await writeNativeStory({
      targetRepoRoot: root,
      title: "Persist the backlog ledger",
      narrative: {
        role: "operator",
        want: "the plugin to write sprint-status.yaml",
        so_that: "the backlog ledger is durable",
      },
      acceptance_criteria: [
        {
          text: "**Given** a backlog, **When** the operator runs it, **Then** sprint-status.yaml is updated and read back unchanged.",
          kind: "integration",
          verification: { type: "vitest", target: "src/__tests__/ledger.integration.test.ts" },
        },
      ],
      tasks: [{ text: "Write the ledger path", ac_refs: ["AC1"] }],
      cited_sources: ["src/state/ledger.ts"],
      depends_on: [],
    });

    expect(result.ref).toMatch(/^native:[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.path.startsWith(storiesDir)).toBe(true);

    // Exactly one native-story file landed on disk.
    expect(await listStoryFiles()).toHaveLength(1);
  });

  it("writes a non-state-mutating candidate even with only a unit AC (heuristic does not fire)", async () => {
    const result = await writeNativeStory({
      targetRepoRoot: root,
      title: "Render a friendly greeting",
      narrative: {
        role: "user",
        want: "a friendly greeting",
        so_that: "the app feels welcoming",
      },
      acceptance_criteria: [
        {
          text: "**Given** the app is open, **When** the user lands, **Then** a greeting is shown.",
          kind: "unit",
          verification: { type: "vitest", target: "src/__tests__/greeting.test.ts" },
        },
      ],
      tasks: [{ text: "Render the greeting component", ac_refs: ["AC1"] }],
      cited_sources: ["src/ui/greeting.ts"],
      depends_on: [],
    });

    expect(result.ref).toMatch(/^native:/);
    expect(await listStoryFiles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC1 — the verification field survives write→parse and the write fails closed
//        when it is absent (the observable spine of Story 10.1)
// ---------------------------------------------------------------------------

describe("writeNativeStory AC1 — verification round-trip + fail-closed on absence", () => {
  it("(a) writes a story whose every AC has a verification block and round-trips it through parseNativeStory intact", async () => {
    const result = await writeNativeStory({
      targetRepoRoot: root,
      title: "Multi-AC story with per-AC verification",
      narrative: { role: "user", want: "a feature", so_that: "I get value" },
      acceptance_criteria: [
        {
          text: "**Given** a state, **When** an action, **Then** an outcome.",
          kind: "unit",
          verification: { type: "vitest", target: "src/feature/__tests__/a.test.ts" },
        },
        {
          text: "**Given** a system, **When** integrated, **Then** an artifact appears.",
          kind: "integration",
          verification: { type: "artifact", target: "build/out/report.json" },
        },
      ],
      tasks: [{ text: "Build the feature", ac_refs: ["AC1", "AC2"] }],
      cited_sources: ["src/feature/index.ts"],
      depends_on: [],
    });

    // Exactly one file landed; re-read and re-parse it.
    expect(await listStoryFiles()).toHaveLength(1);
    const written = await fs.readFile(result.path, "utf8");
    const reparsed = parseNativeStory(result.path, written);

    expect(reparsed.acceptance_criteria).toHaveLength(2);
    expect(reparsed.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: "src/feature/__tests__/a.test.ts",
    });
    expect(reparsed.acceptance_criteria[1]!.verification).toEqual({
      type: "artifact",
      target: "build/out/report.json",
    });
  });

  it("(b) refuses a write where any AC omits the verification block — before any file is written, naming the offending AC", async () => {
    let caught: unknown;
    try {
      await writeNativeStory({
        targetRepoRoot: root,
        title: "Story whose second AC omits verification",
        narrative: { role: "user", want: "a feature", so_that: "I get value" },
        acceptance_criteria: [
          {
            text: "**Given** a state, **When** an action, **Then** an outcome.",
            kind: "unit",
            verification: { type: "vitest", target: "src/feature/__tests__/a.test.ts" },
          },
          // Second AC deliberately omits `verification`.
          {
            text: "**Given** a system, **When** integrated, **Then** an artifact appears.",
            kind: "integration",
          },
        ],
        tasks: [{ text: "Build the feature", ac_refs: ["AC1", "AC2"] }],
        cited_sources: ["src/feature/index.ts"],
        depends_on: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // The validation error names the offending AC by its index in the array.
    const message = String(caught);
    expect(message).toMatch(/acceptance_criteria/);
    expect(message).toMatch(/verification/);
    expect(message).toMatch(/\b1\b/); // the second AC (index 1)

    // Fail-closed: no native-story file appears on disk.
    expect(await listStoryFiles()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 (Story 10.2) — tasks[] / cited_sources[] / structured narrative survive
//   write→parse, and the write fails closed on each violation.
// ---------------------------------------------------------------------------

/** A valid candidate carrying the three new 10.2 fields, with overrides. */
function candidate10_2(overrides: Record<string, unknown> = {}) {
  return {
    targetRepoRoot: root,
    title: "A story exercising the 10.2 fields",
    narrative: { role: "developer", want: "a typed parser", so_that: "fields cannot drift" },
    acceptance_criteria: [
      {
        text: "**Given** a state, **When** an action, **Then** an outcome.",
        kind: "unit" as const,
        verification: { type: "vitest" as const, target: "src/__tests__/a.test.ts" },
      },
      {
        text: "**Given** a system, **When** integrated, **Then** an artifact appears.",
        kind: "integration" as const,
        verification: { type: "artifact" as const, target: "build/out.json" },
      },
    ],
    tasks: [
      { text: "Build the parser", ac_refs: ["AC1"] },
      { text: "Wire the integration", ac_refs: ["AC1", "AC2"] },
    ],
    cited_sources: ["src/parser.ts", "docs/design.md"],
    depends_on: [] as string[],
    ...overrides,
  };
}

describe("writeNativeStory AC1 (Story 10.2) — tasks / cited_sources / narrative round-trip + fail-closed", () => {
  it("(a) writes a story with structured narrative, tasks→ac_refs, and cited sources, and round-trips all three through parseNativeStory", async () => {
    const result = await writeNativeStory(candidate10_2());

    expect(await listStoryFiles()).toHaveLength(1);
    const reparsed = parseNativeStory(result.path, await fs.readFile(result.path, "utf8"));

    expect(reparsed.narrative_struct).toEqual({
      role: "developer",
      want: "a typed parser",
      so_that: "fields cannot drift",
    });
    expect(reparsed.tasks).toEqual([
      { text: "Build the parser", ac_refs: ["AC1"] },
      { text: "Wire the integration", ac_refs: ["AC1", "AC2"] },
    ]);
    expect(reparsed.cited_sources).toEqual(["src/parser.ts", "docs/design.md"]);
  });

  it("(b) refuses a write that omits tasks — before any file is written", async () => {
    const message = String(await rejectionOf(candidate10_2({ tasks: undefined })));
    expect(message).toMatch(/tasks/);
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("(b) refuses a write whose task ac_refs names a non-existent AC — naming the violation, nothing written", async () => {
    // AC9 dangles: the story declares only AC1 and AC2. Story 10.3 moves this
    // rejection earlier — the pure T0-1 check (`task-ac-ref-unresolved`) in the
    // write-time discipline gate now catches the dangling ref BEFORE the
    // parse round-trip, throwing a DisciplineViolationError that names AC9. Both
    // paths reject and write nothing; the discipline gate is the Tier-0 seam.
    let caught: unknown;
    try {
      await writeNativeStory(candidate10_2({ tasks: [{ text: "Dangling", ac_refs: ["AC9"] }] }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const violations = (caught as DisciplineViolationError).violations;
    expect(violations.some((v) => v.code === "task-ac-ref-unresolved")).toBe(true);
    expect(violations.some((v) => /AC9/.test(v.detail))).toBe(true);
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("(b) refuses a write that omits cited sources — before any file is written", async () => {
    const message = String(await rejectionOf(candidate10_2({ cited_sources: undefined })));
    expect(message).toMatch(/cited_sources/);
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("(b) refuses a write whose narrative is not in role/want/so_that shape", async () => {
    // A narrative object missing `so_that` fails the input schema before any write.
    const message = String(await rejectionOf(candidate10_2({ narrative: { role: "x", want: "y" } })));
    expect(message).toMatch(/narrative|so_that/);
    expect(await listStoryFiles()).toHaveLength(0);
  });
});

/** Run writeNativeStory and return the thrown value (fails the test if it resolves). */
async function rejectionOf(input: unknown): Promise<unknown> {
  try {
    await writeNativeStory(input);
  } catch (err) {
    return err;
  }
  throw new Error("expected writeNativeStory to reject, but it resolved");
}

// ---------------------------------------------------------------------------
// Story 10.8 — AC1 + AC2: build-ready first-pass blocks
//
// AC1: a sparse draft authored through the write seam renders all three
//   build-ready sub-sections (Files-touched, Definition-of-Done, Risk) as
//   non-empty content inside ## Implementation Notes.
//
// AC2: a sparse draft authored through the write seam, then re-parsed from
//   the file the seam produced, retains all three sub-sections in the parsed
//   implementation_notes — including the build-time defaults.
// ---------------------------------------------------------------------------

/** A minimal sparse candidate — none of the three build-ready fields supplied. */
function sparseCandidate() {
  return {
    targetRepoRoot: root,
    title: "A sparse story with no build-ready blocks supplied",
    narrative: {
      role: "developer",
      want: "the write seam to fill in build-ready blocks",
      so_that: "I have something to work from even on a lean draft",
    },
    acceptance_criteria: [
      {
        text: "**Given** a sparse draft, **When** authored through the write seam, **Then** all three build-ready sub-sections render non-empty.",
        kind: "integration" as const,
        verification: {
          type: "vitest" as const,
          target: "src/tools/__tests__/write-native-story.test.ts",
        },
      },
    ],
    tasks: [{ text: "Author a sparse story and assert the build-ready blocks are present", ac_refs: ["AC1"] }],
    cited_sources: ["src/parser.ts"],
    depends_on: [] as string[],
    // Intentionally omit: implementation_notes, files_touched, definition_of_done, risk_reasoning
  };
}

describe("writeNativeStory Story 10.8 — build-ready first-pass blocks", () => {
  it("AC1: a sparse draft authored through the write seam renders all three build-ready sub-sections as non-empty in the produced body", async () => {
    const result = await writeNativeStory(sparseCandidate());

    expect(await listStoryFiles()).toHaveLength(1);

    // Read the file the seam produced and assert the three sub-sections are present and non-empty.
    const body = await fs.readFile(result.path, "utf8");

    // All three sub-section headings must be present.
    expect(body).toMatch(/^### Files touched/m);
    expect(body).toMatch(/^### Definition of Done/m);
    expect(body).toMatch(/^### Risk/m);

    // Each sub-section must be non-empty: extract the content between the heading
    // and the next heading or end-of-string.
    const filesTouchedMatch = /### Files touched\n+([\s\S]+?)(?=\n###|\n##|$)/.exec(body);
    expect(filesTouchedMatch).not.toBeNull();
    expect(filesTouchedMatch![1]!.trim().length).toBeGreaterThan(0);

    const dodMatch = /### Definition of Done\n+([\s\S]+?)(?=\n###|\n##|$)/.exec(body);
    expect(dodMatch).not.toBeNull();
    expect(dodMatch![1]!.trim().length).toBeGreaterThan(0);

    const riskMatch = /### Risk\n+([\s\S]+?)(?=\n###|\n##|$)/.exec(body);
    expect(riskMatch).not.toBeNull();
    expect(riskMatch![1]!.trim().length).toBeGreaterThan(0);
  });

  it("AC2: a sparse draft authored through the write seam, then re-parsed from the produced file, retains all three build-ready sub-sections in the parsed implementation_notes", async () => {
    const result = await writeNativeStory(sparseCandidate());

    // Re-parse the file the seam produced — this is the AC2 end-to-end round-trip.
    const body = await fs.readFile(result.path, "utf8");
    const reparsed = parseNativeStory(result.path, body);

    // The parser preserves ## Implementation Notes verbatim into implementation_notes.
    expect(reparsed.implementation_notes).toBeDefined();
    const notes = reparsed.implementation_notes!;

    // All three sub-section headings survive the round-trip.
    expect(notes).toMatch(/^### Files touched/m);
    expect(notes).toMatch(/^### Definition of Done/m);
    expect(notes).toMatch(/^### Risk/m);

    // Each sub-section in the parsed notes is non-empty (the defaults persisted).
    const filesTouchedMatch = /### Files touched\n+([\s\S]+?)(?=\n###|$)/.exec(notes);
    expect(filesTouchedMatch).not.toBeNull();
    expect(filesTouchedMatch![1]!.trim().length).toBeGreaterThan(0);

    const dodMatch = /### Definition of Done\n+([\s\S]+?)(?=\n###|$)/.exec(notes);
    expect(dodMatch).not.toBeNull();
    expect(dodMatch![1]!.trim().length).toBeGreaterThan(0);

    const riskMatch = /### Risk\n+([\s\S]+?)(?=\n###|$)/.exec(notes);
    expect(riskMatch).not.toBeNull();
    expect(riskMatch![1]!.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Story 10.3 AC4 — writeNativeStory rejects native stories failing the
//   writable-time Tier-0 checks (T0-5 cited sources resolve, the pure part of
//   T0-6 reject invented flags), throwing DisciplineViolationError, nothing
//   written. New-test-file `vitest:` targets are NOT existence-checked at write.
// ---------------------------------------------------------------------------

describe("writeNativeStory AC4 (Story 10.3) — writable-time Tier-0 gate", () => {
  it("rejects a cited source that does not resolve on disk (T0-5), nothing written", async () => {
    let caught: unknown;
    try {
      await writeNativeStory(
        candidate10_2({ cited_sources: ["src/parser.ts", "src/does-not-exist.ts"] }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("unresolvable-cited-source");
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("rejects an invented-flag verification target (pure part of T0-6), nothing written", async () => {
    let caught: unknown;
    try {
      await writeNativeStory(
        candidate10_2({
          acceptance_criteria: [
            {
              text: "**Given** a state, **When** an action, **Then** an outcome.",
              kind: "unit" as const,
              // An invented flag — not a path. T0-6 rejects this shape.
              verification: { type: "vitest" as const, target: "vitest --grep foo" },
            },
            {
              text: "**Given** a system, **When** integrated, **Then** an artifact appears.",
              kind: "integration" as const,
              verification: { type: "artifact" as const, target: "build/out.json" },
            },
          ],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("invalid-verification-target");
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("rejects an `artifact:` target that does not resolve on disk (T0-6 disk), nothing written", async () => {
    let caught: unknown;
    try {
      await writeNativeStory(
        candidate10_2({
          acceptance_criteria: [
            {
              text: "**Given** a state, **When** an action, **Then** an outcome.",
              kind: "unit" as const,
              verification: { type: "vitest" as const, target: "src/__tests__/a.test.ts" },
            },
            {
              text: "**Given** a system, **When** integrated, **Then** an artifact appears.",
              kind: "integration" as const,
              // An artifact that does not exist — must resolve at write.
              verification: { type: "artifact" as const, target: "build/missing.json" },
            },
          ],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DisciplineViolationError);
    const codes = (caught as DisciplineViolationError).violations.map((v) => v.code);
    expect(codes).toContain("unresolvable-verification-target");
    expect(await listStoryFiles()).toHaveLength(0);
  });

  it("WRITES a story whose every `vitest:` target is a brand-new (non-existent) test file (chicken-and-egg exemption)", async () => {
    // Both vitest targets point at test files the BUILD will create — they do
    // NOT exist at write time. The write must succeed: vitest targets are
    // shape-checked, not existence-checked.
    const result = await writeNativeStory(
      candidate10_2({
        acceptance_criteria: [
          {
            text: "**Given** a state, **When** an action, **Then** an outcome.",
            kind: "unit" as const,
            verification: { type: "vitest" as const, target: "src/__tests__/brand-new-a.test.ts" },
          },
          {
            text: "**Given** a system, **When** integrated, **Then** an outcome.",
            kind: "integration" as const,
            verification: { type: "vitest" as const, target: "src/__tests__/brand-new-b.test.ts" },
          },
        ],
      }),
    );
    expect(result.ref).toMatch(/^native:/);
    expect(await listStoryFiles()).toHaveLength(1);
  });
});
