/**
 * Unit tests for `readManifestAcs`.
 * Story native:01KT6QGBWP7KJDVMHQK3MEKDXP (inline-spec-to-builder).
 *
 * Verifies that the tool reads an execution manifest and returns its
 * acceptance_criteria as AcEntry-compatible objects suitable for passing
 * inline to the builder via `runDevTerminalAction`'s `inlineAcs` field.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { readManifestAcs } from "../read-manifest-acs.js";

const SOURCE_HASH = "a".repeat(64);

interface TestContext {
  tmpDir: string;
  manifestPath: string;
}

let ctx: TestContext;

beforeEach(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-manifest-acs-"));
  const stateDir = path.join(tmpDir, ".flow", "state", "in-progress");
  await fs.mkdir(stateDir, { recursive: true });
  ctx = { tmpDir, manifestPath: path.join(stateDir, "native:01KTEST.yaml") };
});

afterEach(async () => {
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
});

async function writeManifest(
  acceptance_criteria: Array<{ text: string; kind: "unit" | "integration"; verification?: { type: "vitest"; target: string } }>,
): Promise<void> {
  const manifest = {
    ref: "native:01KTEST",
    status: "in-progress",
    adapter: "native",
    source_path: ".flow/native-stories/01KTEST.md",
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria,
    title: "Test story",
    narrative: "As a tester, I want ACs.",
    withdrawn: false,
    claimed_by: "01TESTSESSION",
  };
  await atomicWriteFile(ctx.manifestPath, yamlStringify(manifest));
}

describe("readManifestAcs", () => {
  it("returns one AcEntry per acceptance criterion in numeric index order", async () => {
    await writeManifest([
      { text: "Given A, When B, Then C.", kind: "integration" },
      { text: "Given X, When Y, Then Z.", kind: "unit" },
    ]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs).toHaveLength(2);
    expect(acs[0]!.index).toBe(1);
    expect(acs[1]!.index).toBe(2);
  });

  it("sets firstLine to the first non-blank line of the AC text, truncated to 120 chars", async () => {
    const longText = "A ".repeat(80); // 160 chars
    await writeManifest([{ text: "\n\n" + longText, kind: "unit" }]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs[0]!.firstLine.length).toBeLessThanOrEqual(120);
    expect(acs[0]!.firstLine).toBe(longText.trim().slice(0, 120));
  });

  it("sets tag to 'integration' for ACs with kind: integration", async () => {
    await writeManifest([{ text: "Given A, When B, Then C.", kind: "integration" }]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs[0]!.tag).toBe("integration");
  });

  it("sets tag to null for ACs with kind: unit", async () => {
    await writeManifest([{ text: "Given X, When Y, Then Z.", kind: "unit" }]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs[0]!.tag).toBeNull();
  });

  it("populates body with all lines of the AC text", async () => {
    const text = "Line one.\nLine two.\nLine three.";
    await writeManifest([{ text, kind: "unit" }]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs[0]!.body).toEqual(text.split("\n"));
  });

  it("assigns sequential 1-based indexes regardless of order in the manifest", async () => {
    await writeManifest([
      { text: "First AC.", kind: "unit" },
      { text: "Second AC.", kind: "integration" },
      { text: "Third AC.", kind: "unit" },
    ]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs.map((a) => a.index)).toEqual([1, 2, 3]);
  });

  it("returns the firstLine trimmed and capped at 120 chars", async () => {
    const exactlyAt120 = "x".repeat(120);
    const beyond120 = "x".repeat(150);

    await writeManifest([
      { text: exactlyAt120, kind: "unit" },
      { text: beyond120, kind: "unit" },
    ]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs[0]!.firstLine).toHaveLength(120);
    expect(acs[1]!.firstLine).toHaveLength(120);
  });

  it("throws when the manifest does not exist", async () => {
    await expect(
      readManifestAcs({ manifestPath: path.join(ctx.tmpDir, "does-not-exist.yaml") }),
    ).rejects.toThrow();
  });

  it("works for a manifest with a single AC", async () => {
    await writeManifest([
      { text: "Given a single AC, When it is read, Then it is returned.", kind: "integration" },
    ]);

    const { acs } = await readManifestAcs({ manifestPath: ctx.manifestPath });

    expect(acs).toHaveLength(1);
    expect(acs[0]!.index).toBe(1);
    expect(acs[0]!.tag).toBe("integration");
    expect(acs[0]!.firstLine).toBe(
      "Given a single AC, When it is read, Then it is returned.",
    );
  });
});
