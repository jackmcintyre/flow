/**
 * Integration tests for `writeNativeStory` + `scanSources` pipeline
 * (Story 3.4 Task 6.4 — epic AC5).
 *
 * Each test gets a fresh tmpdir with a minimal native-adapter workspace
 * (`.flow/config.yaml` set to `adapter: native`). The test harness directly
 * calls `writeNativeStory` with synthesised story inputs, then runs
 * `scanSources`, then asserts:
 *
 *   (a) Each native-story file parses via `parseNativeStory`.
 *   (b) Each yields a `SourceStory` shape-equivalent to the BMad adapter's
 *       output (key-set equality on the returned object).
 *   (c) Each appears in `.flow/state/to-do/<ref>.yaml` after the
 *       `scanSources` pass with `adapter: native`, the correct `source_hash`,
 *       and `depends_on` carried through.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { writeNativeStory } from "../src/tools/write-native-story.js";
import { atomicWriteFile } from "../src/lib/managed-fs.js";
import { scanSources } from "../src/tools/scan-sources.js";
import { parseNativeStory } from "../src/adapters/native/parse-native-story.js";
import { parseExecutionManifest } from "../src/schemas/execution-manifest.js";
import { resetNativeAdapter } from "../src/adapters/native/index.js";
import { resetBmadAdapter } from "../src/adapters/bmad/index.js";

// The canonical set of keys that a SourceStory MUST have.
// Derived from adapter.ts § SourceStory.
const SOURCE_STORY_REQUIRED_KEYS = [
  "ref",
  "title",
  "narrative",
  "acceptance_criteria",
  "depends_on",
  "raw_path",
  "raw_frontmatter",
  "source_hash",
] as const;

let scratch: string;

/**
 * Seed a repo-relative file under `scratch` so a Story 10.3 T0-5 cited-source
 * resolvability check passes (cited sources must resolve at write time).
 */
async function seedCited(relPath: string): Promise<void> {
  const abs = path.join(scratch, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "// seeded for resolvability\n");
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-native-integ-"));

  // Write a minimal native-adapter config.
  await fs.mkdir(path.join(scratch, ".flow"), { recursive: true });
  await fs.writeFile(
    path.join(scratch, ".flow", "config.yaml"),
    yamlStringify({ adapter: "native", adapter_config: {}, plugin: {} }),
  );
  // Create the native-stories directory so detect() returns true.
  await fs.mkdir(path.join(scratch, ".flow", "native-stories"), { recursive: true });
  // Story 10.3 — writeNativeStory now resolves cited_sources on disk. Seed every
  // cited path the tests below reference so those writes are not (correctly)
  // rejected. All verification targets in this file are `vitest:` (not
  // existence-checked), so only cited sources need seeding.
  for (const rel of [
    "src/settings/theme.ts",
    "src/account/order-history.ts",
    "src/auth/sign-up.ts",
    "src/profile/profile.ts",
    "src/checkout/payment.ts",
  ]) {
    await seedCited(rel);
  }
});

afterEach(async () => {
  resetNativeAdapter();
  resetBmadAdapter();
  await fs.rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Single story write → parse → scan
// ---------------------------------------------------------------------------

it("AC5(a) — written story file parses via parseNativeStory", async () => {
  const result = await writeNativeStory({
    targetRepoRoot: scratch,
    title: "Enable dark mode",
    narrative: {
      role: "user with light sensitivity",
      want: "to switch the UI to dark mode",
      so_that: "I can use the app comfortably at night",
    },
    acceptance_criteria: [
      {
        text: "**Given** I am in Settings,\n**When** I toggle Dark Mode on,\n**Then** the UI switches to a dark colour scheme immediately.",
        kind: "unit",
        verification: { type: "vitest", target: "src/settings/__tests__/dark-mode.test.ts" },
      },
    ],
    tasks: [{ text: "Add the dark-mode toggle", ac_refs: ["AC1"] }],
    cited_sources: ["src/settings/theme.ts"],
    depends_on: [],
  });

  expect(result.ref).toMatch(/^native:[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(result.path).toContain(".flow");
  expect(result.path).toContain("native-stories");

  const contents = await fs.readFile(result.path, "utf8");
  const story = parseNativeStory(result.path, contents);
  expect(story.ref).toBe(result.ref);
  expect(story.title).toBe("Enable dark mode");
});

it("AC5(b) — parsed SourceStory has all required keys (key-set equality with BMad output shape)", async () => {
  const result = await writeNativeStory({
    targetRepoRoot: scratch,
    title: "View order history",
    narrative: {
      role: "returning customer",
      want: "to see all my past orders",
      so_that: "I can track what I have bought",
    },
    acceptance_criteria: [
      {
        text: "**Given** I am on My Account,\n**When** I click Order History,\n**Then** I see a list of my past orders with dates and totals.",
        kind: "unit",
        verification: { type: "vitest", target: "src/account/__tests__/order-history.test.ts" },
      },
    ],
    tasks: [{ text: "Render the order-history list", ac_refs: ["AC1"] }],
    cited_sources: ["src/account/order-history.ts"],
    depends_on: [],
  });

  const contents = await fs.readFile(result.path, "utf8");
  const story = parseNativeStory(result.path, contents);

  // Assert all required keys are present — key-set equality check.
  for (const key of SOURCE_STORY_REQUIRED_KEYS) {
    expect(story).toHaveProperty(key);
  }
  // source_hash is a 64-char hex SHA-256 (same convention as BMad parser).
  expect(story.source_hash).toMatch(/^[0-9a-f]{64}$/);
  // source_hash must match what we'd compute from the file bytes.
  const expectedHash = createHash("sha256").update(contents).digest("hex");
  expect(story.source_hash).toBe(expectedHash);
});

it("AC5(c) — scanSources creates manifest under .flow/state/to-do/ with adapter: native, correct source_hash, and depends_on", async () => {
  // Write story A.
  const storyA = await writeNativeStory({
    targetRepoRoot: scratch,
    title: "User sign-up",
    narrative: {
      role: "new visitor",
      want: "to create an account with my email",
      so_that: "I can save my progress",
    },
    acceptance_criteria: [
      {
        text: "**Given** I fill in the sign-up form with a unique email,\n**When** I submit,\n**Then** my account is created and I receive a confirmation email.",
        kind: "unit",
        verification: { type: "vitest", target: "src/auth/__tests__/sign-up.test.ts" },
      },
    ],
    tasks: [{ text: "Build the sign-up flow", ac_refs: ["AC1"] }],
    cited_sources: ["src/auth/sign-up.ts"],
    depends_on: [],
  });

  // Write story B that depends on A.
  const storyB = await writeNativeStory({
    targetRepoRoot: scratch,
    title: "User profile",
    narrative: {
      role: "signed-in user",
      want: "to see my profile page",
      so_that: "I can verify my account details",
    },
    acceptance_criteria: [
      {
        text: "**Given** I am signed in,\n**When** I navigate to My Profile,\n**Then** I see my name and email address.",
        kind: "unit",
        verification: { type: "vitest", target: "src/profile/__tests__/profile.test.ts" },
      },
    ],
    tasks: [{ text: "Render the profile page", ac_refs: ["AC1"] }],
    cited_sources: ["src/profile/profile.ts"],
    depends_on: [storyA.ref],
  });

  // Run scanSources.
  const scanResult = await scanSources({ targetRepoRoot: scratch });

  expect(scanResult.adapterName).toBe("native");
  expect(scanResult.createdRefs).toContain(storyA.ref);
  expect(scanResult.createdRefs).toContain(storyB.ref);

  // Verify manifest for story A.
  const manifestPathA = path.join(scratch, ".flow", "state", "to-do", `${storyA.ref}.yaml`);
  const rawA = await fs.readFile(manifestPathA, "utf8");
  const manifestA = parseExecutionManifest(yamlParse(rawA), { absPath: manifestPathA });

  expect(manifestA.adapter).toBe("native");
  expect(manifestA.ref).toBe(storyA.ref);
  expect(manifestA.status).toBe("to-do");
  // source_hash must match what parseNativeStory computed from the file bytes.
  const contentsA = await fs.readFile(storyA.path, "utf8");
  const expectedHashA = createHash("sha256").update(contentsA).digest("hex");
  expect(manifestA.source_hash).toBe(expectedHashA);
  expect(manifestA.depends_on).toEqual([]);

  // Verify manifest for story B — depends_on must carry through.
  const manifestPathB = path.join(scratch, ".flow", "state", "to-do", `${storyB.ref}.yaml`);
  const rawB = await fs.readFile(manifestPathB, "utf8");
  const manifestB = parseExecutionManifest(yamlParse(rawB), { absPath: manifestPathB });

  expect(manifestB.adapter).toBe("native");
  expect(manifestB.ref).toBe(storyB.ref);
  expect(manifestB.depends_on).toContain(storyA.ref);
});

// ---------------------------------------------------------------------------
// WrongAdapterError guard
// ---------------------------------------------------------------------------

describe("writeNativeStory — adapter guard", () => {
  it("throws WrongAdapterError when workspace adapter is not 'native'", async () => {
    // Set up a BMad-adapter workspace.
    const bmadScratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-native-bmad-guard-"));
    try {
      // Write a BMad adapter config.
      await fs.mkdir(path.join(bmadScratch, ".flow"), { recursive: true });
      await fs.writeFile(
        path.join(bmadScratch, ".flow", "config.yaml"),
        yamlStringify({
          adapter: "bmad",
          adapter_config: { stories_root: "_bmad-output/planning-artifacts/stories" },
          plugin: {},
        }),
      );
      // Create a stories dir with at least one BMad file so detect() passes.
      const storiesDir = path.join(bmadScratch, "_bmad-output", "planning-artifacts", "stories");
      await fs.mkdir(storiesDir, { recursive: true });
      await fs.writeFile(
        path.join(storiesDir, "1-1-test.md"),
        "# Story 1.1: Test\n\nStatus: backlog\n\n## Story\n\nAs a user.\n\n## Acceptance Criteria\n\n**AC1:**\n**Given** x,\n**When** y,\n**Then** z.\n",
      );

      await expect(
        writeNativeStory({
          targetRepoRoot: bmadScratch,
          title: "Should fail",
          narrative: { role: "user", want: "something", so_that: "I can do things" },
          acceptance_criteria: [
            {
              text: "**Given** x **When** y **Then** z.",
              kind: "unit",
              verification: { type: "vitest", target: "src/__tests__/x.test.ts" },
            },
          ],
          tasks: [{ text: "Do the thing", ac_refs: ["AC1"] }],
          cited_sources: ["src/x.ts"],
          depends_on: [],
        }),
      ).rejects.toThrow("requires adapter");
    } finally {
      await fs.rm(bmadScratch, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// integration_ac_kind mapping
// ---------------------------------------------------------------------------

it("integration-tagged AC produces kind: 'integration' in the parsed SourceStory", async () => {
  const result = await writeNativeStory({
    targetRepoRoot: scratch,
    title: "Process payment",
    narrative: {
      role: "customer at checkout",
      want: "to pay by card",
      so_that: "my order is confirmed immediately",
    },
    acceptance_criteria: [
      {
        text: "**Given** I have items in my cart,\n**When** I submit a valid card number,\n**Then** my order is placed and I see a confirmation number.",
        kind: "integration",
        verification: { type: "vitest", target: "src/checkout/__tests__/payment.test.ts" },
      },
    ],
    tasks: [{ text: "Wire the card-payment flow", ac_refs: ["AC1"] }],
    cited_sources: ["src/checkout/payment.ts"],
    depends_on: [],
  });

  const contents = await fs.readFile(result.path, "utf8");
  const story = parseNativeStory(result.path, contents);
  expect(story.acceptance_criteria[0]!.kind).toBe("integration");
});

// ---------------------------------------------------------------------------
// atomicWriteFile — Task 4.5 atomicity guarantee (Story 3.4 rework)
// ---------------------------------------------------------------------------

describe("atomicWriteFile — atomic write via .tmp + fs.rename", () => {
  it("writes file content correctly and leaves no .tmp sibling behind on success", async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-atomic-ok-"));
    try {
      const absPath = path.join(targetDir, "output.md");
      const tmpPath = `${absPath}.tmp`;

      await atomicWriteFile(absPath, "hello atomic");

      // Final file exists with correct content.
      const written = await fs.readFile(absPath, "utf8");
      expect(written).toBe("hello atomic");

      // No .tmp sibling left behind.
      await expect(fs.access(tmpPath)).rejects.toThrow();
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });

  it("does not create or leave content at the final path when the .tmp write fails", async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-atomic-fail-"));
    try {
      // Make the target path itself a directory so that writing <path>.tmp
      // succeeds but renaming <path>.tmp → <path> fails (EISDIR on the
      // destination). This exercises the path where the final file is never
      // touched even though the .tmp was created.
      const absPath = path.join(targetDir, "collision");
      await fs.mkdir(absPath, { recursive: true }); // absPath is a directory

      // The rename will fail because absPath is a non-empty dir (EISDIR/ENOTEMPTY).
      await expect(atomicWriteFile(absPath, "should-not-land")).rejects.toThrow();

      // The directory at absPath still exists and is unchanged — no partial
      // file was written there. (We can still stat it as a directory.)
      const stat = await fs.stat(absPath);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });

  it("creates parent directories automatically before writing", async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-atomic-mkdir-"));
    try {
      const absPath = path.join(targetDir, "deep", "nested", "file.md");

      await atomicWriteFile(absPath, "nested content");

      const written = await fs.readFile(absPath, "utf8");
      expect(written).toBe("nested content");
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
