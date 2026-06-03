/**
 * Integration tests for `lookupRiskTieringSpec` — Story 4.9 Task 6.1–6.2.
 *
 * Covers AC4 cases:
 *   (4b) Shipped-default-loads case — no override present
 *   (4c) Override-wins-when-present case — both files present, override wins
 *   (4d) Malformed-override-errors-clearly case — three sub-cases
 *         (c1) missing frontmatter opener
 *         (c2) invalid change_types enum value
 *         (c3) duplicate rule ids
 *   (4e) Non-AC extras:
 *         shipped default missing → ShippedRiskTieringDefaultMissingError
 *         schema-sharing: same YAML → same parsed tiers (modulo sourcePath)
 *         rule with no signal fields → MalformedRiskTieringSpecError
 *         fallback_tier: low → MalformedRiskTieringSpecError
 *         min > max → MalformedRiskTieringSpecError
 *         empty tiers → MalformedRiskTieringSpecError
 *   (4f) Round-trip against the shipped default's literal content
 *
 * Fixture pattern: `fs.mkdtemp(path.join(os.tmpdir(), "risk-tier-"))` per
 * `beforeEach`; `fs.rm(..., { recursive: true })` in `afterEach`.
 * Files are written via `atomicWriteFile` to comply with the static
 * fs-write guard (canonical-fs-guard.test.ts AC5c). No `pluginRoot`
 * resolution via `import.meta.url`; tests pass it explicitly.
 *
 * Pure deterministic — no LLM invocation, no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lookupRiskTieringSpec } from "../lookup-risk-tiering-spec.js";
import {
  MalformedRiskTieringSpecError,
  ShippedRiskTieringDefaultMissingError,
} from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** The shipped default's literal content (must match plugins/flow/docs/risk-tiering.md). */
const SHIPPED_DEFAULT_CONTENT = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
        - "**/*.md"
  high:
    - id: high.schema-or-migration
      change_types:
        - migration
        - schema
---

# Risk-tiering rules

This file declares the rules.
`;

/** A distinguishable override with a different version and rule id. */
const OVERRIDE_CONTENT = `---
version: "2.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.custom-override
      change_types:
        - revert
---

# Custom override rules
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let targetRepoRoot: string;
let pluginRoot: string;

beforeEach(async () => {
  targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "risk-tier-target-"));
  pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "risk-tier-plugin-"));
});

afterEach(async () => {
  await fs.rm(targetRepoRoot, { recursive: true, force: true });
  await fs.rm(pluginRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers — use atomicWriteFile to comply with the static fs-write guard
// ---------------------------------------------------------------------------

async function writeDefault(content: string = SHIPPED_DEFAULT_CONTENT): Promise<string> {
  const filePath = path.join(pluginRoot, "docs", "risk-tiering.md");
  await atomicWriteFile(filePath, content);
  return filePath;
}

async function writeOverride(content: string = OVERRIDE_CONTENT): Promise<string> {
  const filePath = path.join(targetRepoRoot, "docs", "risk-tiering.md");
  await atomicWriteFile(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// (4b) Shipped-default-loads case
// ---------------------------------------------------------------------------

describe("lookupRiskTieringSpec — shipped default (no override)", () => {
  it("returns the default spec when no override is present", async () => {
    const defaultFilePath = await writeDefault();
    const spec = await lookupRiskTieringSpec({ targetRepoRoot, pluginRoot });

    expect(spec.sourcePath).toBe(defaultFilePath);
    expect(spec.version).toBe("1.0.0");
    expect(spec.fallback_tier).toBe("medium");
    expect(spec.tiers.low).toHaveLength(1);
    expect(spec.tiers.low![0]!.id).toBe("low.docs-only");
    expect(spec.tiers.high).toHaveLength(1);
    expect(spec.tiers.high![0]!.id).toBe("high.schema-or-migration");
  });
});

// ---------------------------------------------------------------------------
// (4c) Override-wins-when-present case
// ---------------------------------------------------------------------------

describe("lookupRiskTieringSpec — override wins", () => {
  it("returns override spec when both files are present", async () => {
    await writeDefault();
    const overrideFilePath = await writeOverride();

    const spec = await lookupRiskTieringSpec({ targetRepoRoot, pluginRoot });

    expect(spec.sourcePath).toBe(overrideFilePath);
    expect(spec.version).toBe("2.0.0");
    expect(spec.tiers.high).toHaveLength(1);
    expect(spec.tiers.high![0]!.id).toBe("high.custom-override");
    // Shipped default content must NOT be present
    expect(spec.tiers.low).toBeUndefined();
  });

  it("override sourcePath points at target-repo path, not plugin path", async () => {
    await writeDefault();
    const overrideFilePath = await writeOverride();

    const spec = await lookupRiskTieringSpec({ targetRepoRoot, pluginRoot });
    expect(spec.sourcePath).toBe(overrideFilePath);
    expect(spec.sourcePath).not.toBe(path.join(pluginRoot, "docs", "risk-tiering.md"));
  });
});

// ---------------------------------------------------------------------------
// (4d) Malformed-override-errors-clearly cases
// ---------------------------------------------------------------------------

describe("lookupRiskTieringSpec — malformed override (c1): missing frontmatter opener", () => {
  it("throws MalformedRiskTieringSpecError with reason matching /missing YAML frontmatter opener/", async () => {
    await writeDefault();
    await writeOverride("version: 1.0.0\nfallback_tier: medium\n");

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toThrow(MalformedRiskTieringSpecError);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/missing YAML frontmatter opener/) });
  });
});

describe("lookupRiskTieringSpec — malformed override (c2): invalid change_types value", () => {
  it("throws MalformedRiskTieringSpecError with reason mentioning change_types", async () => {
    await writeDefault();
    await writeOverride(`---
version: "1.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.bad
      change_types:
        - foobar
---
`);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toThrow(MalformedRiskTieringSpecError);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({
      reason: expect.stringMatching(/change_types/),
    });
  });
});

describe("lookupRiskTieringSpec — malformed override (c3): duplicate rule ids", () => {
  it("throws MalformedRiskTieringSpecError with reason matching /duplicate rule id/", async () => {
    await writeDefault();
    await writeOverride(`---
version: "1.0.0"
fallback_tier: medium
tiers:
  low:
    - id: shared.id
      path_patterns:
        - "docs/**"
  high:
    - id: shared.id
      change_types:
        - migration
---
`);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toThrow(MalformedRiskTieringSpecError);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/duplicate rule id/) });
  });
});

// ---------------------------------------------------------------------------
// (4e) Non-AC extras
// ---------------------------------------------------------------------------

describe("lookupRiskTieringSpec — shipped default missing", () => {
  it("throws ShippedRiskTieringDefaultMissingError when no default and no override", async () => {
    // Neither default nor override files exist
    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toThrow(ShippedRiskTieringDefaultMissingError);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({
      expectedPath: path.join(pluginRoot, "docs", "risk-tiering.md"),
    });
  });
});

describe("lookupRiskTieringSpec — schema-sharing assertion", () => {
  it("produces identical parsed tiers from the same YAML content regardless of source path", async () => {
    await writeDefault(SHIPPED_DEFAULT_CONTENT);
    await writeOverride(SHIPPED_DEFAULT_CONTENT);

    // Load with override present → uses override path
    const specFromOverride = await lookupRiskTieringSpec({ targetRepoRoot, pluginRoot });

    // Remove override to test default
    await fs.rm(path.join(targetRepoRoot, "docs", "risk-tiering.md"));
    const specFromDefault = await lookupRiskTieringSpec({ targetRepoRoot, pluginRoot });

    // tiers must be identical (same YAML, same schema)
    expect(specFromOverride.tiers).toEqual(specFromDefault.tiers);
    expect(specFromOverride.version).toBe(specFromDefault.version);
    expect(specFromOverride.fallback_tier).toBe(specFromDefault.fallback_tier);

    // sourcePath differs
    expect(specFromOverride.sourcePath).not.toBe(specFromDefault.sourcePath);
  });
});

describe("lookupRiskTieringSpec — rule with no signal fields", () => {
  it("throws MalformedRiskTieringSpecError with reason matching /declares no signal fields/", async () => {
    await writeDefault();
    await writeOverride(`---
version: "1.0.0"
fallback_tier: medium
tiers:
  low:
    - id: no-signals
---
`);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/no signal fields/) });
  });
});

describe("lookupRiskTieringSpec — fallback_tier: low", () => {
  it("throws MalformedRiskTieringSpecError with reason matching /fallback_tier must be 'medium'/", async () => {
    await writeDefault();
    await writeOverride(`---
version: "1.0.0"
fallback_tier: low
tiers:
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
---
`);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/fallback_tier must be 'medium'/) });
  });
});

describe("lookupRiskTieringSpec — min_lines_changed > max_lines_changed", () => {
  it("throws MalformedRiskTieringSpecError with reason matching /exceeds max_lines_changed/", async () => {
    await writeDefault();
    await writeOverride(`---
version: "1.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.large-diff
      diff_size_thresholds:
        min_lines_changed: 100
        max_lines_changed: 50
---
`);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/exceeds max_lines_changed/) });
  });
});

describe("lookupRiskTieringSpec — empty tiers", () => {
  it("throws MalformedRiskTieringSpecError with reason matching /no rules declared/", async () => {
    await writeDefault();
    await writeOverride(`---
version: "1.0.0"
fallback_tier: medium
tiers: {}
---
`);

    await expect(
      lookupRiskTieringSpec({ targetRepoRoot, pluginRoot }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/no rules declared/) });
  });
});

// ---------------------------------------------------------------------------
// (4f) Round-trip against shipped default literal content
// ---------------------------------------------------------------------------

describe("lookupRiskTieringSpec — round-trip (4f)", () => {
  it("loads shipped default content and asserts version, tiers.low, tiers.high", async () => {
    await writeDefault(SHIPPED_DEFAULT_CONTENT);

    const spec = await lookupRiskTieringSpec({ targetRepoRoot, pluginRoot });

    expect(spec.version).toBe("1.0.0");
    expect(spec.tiers.low).toHaveLength(1);
    expect(spec.tiers.low![0]!.id).toBe("low.docs-only");
    expect(spec.tiers.low![0]!.path_patterns).toEqual(["docs/**", "**/*.md"]);
    expect(spec.tiers.high).toHaveLength(1);
    expect(spec.tiers.high![0]!.id).toBe("high.schema-or-migration");
    expect(spec.tiers.high![0]!.change_types).toEqual(["migration", "schema"]);
  });
});
