/**
 * Story 8.4 — stateless CLI shim dispatch smoke test.
 *
 * The `run` workflow's seam-agents shell out to
 *   `node dist/cli.js <tool> --json <args>`
 * with NO persistent MCP server on the run path. This verifies the dispatch
 * contract the seam-agents depend on: a known tool round-trips a single JSON
 * line; an unknown tool exits 64 with a typed error; the two newly-wired seam
 * tools (processReviewerYield, scanOrphanedInProgress) are registered; malformed
 * args exit 65. Requires a built `dist/` (same precondition as the dist-shipping
 * test).
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "dist", "cli.js");

async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args]);
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "" };
  }
}

describe("Story 8.4 — stateless CLI shim dispatch", () => {
  it("a known no-arg tool round-trips a single JSON line (mintSessionUlid)", async () => {
    const { code, stdout } = await runCli(["mintSessionUlid"]);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it("an unknown tool exits 64 with a typed unknown-tool error", async () => {
    const { code, stdout } = await runCli(["bogusToolDoesNotExist"]);
    expect(code).toBe(64);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error.kind).toBe("unknown-tool");
  });

  it("the two newly-wired seam tools are registered", async () => {
    // An unknown-tool error lists the known tool names — proves M3's wiring.
    const { stdout } = await runCli(["bogusToolDoesNotExist"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error.known).toContain("processReviewerYield");
    expect(parsed.error.known).toContain("scanOrphanedInProgress");
  });

  it("malformed JSON args exit 65 with a bad-json error", async () => {
    const { code, stdout } = await runCli(["getStatus", "--json", "{not valid"]);
    expect(code).toBe(65);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error.kind).toBe("bad-json");
  });
});

// ---------------------------------------------------------------------------
// markStoryReady on the CLI (Epic 10 run fix-plan, Fix 1).
//
// The run runs MCP-free, so the "bless" mutation had no one-shot seam: every
// run blessed the next story via a hand-written `node` helper. Wiring
// markStoryReady into the CLI TOOLS map makes bless a first-class seam — the
// cutover scan→bless step and `/flow:ready` now round-trip through this transport.
// This proves the tool LOGIC actually runs end-to-end over the CLI, not merely
// that the name is registered.
// ---------------------------------------------------------------------------
describe("markStoryReady CLI seam (Fix 1)", () => {
  const tmpRoots: string[] = [];
  afterEach(async () => {
    while (tmpRoots.length) {
      await fs.rm(tmpRoots.pop()!, { recursive: true, force: true });
    }
  });

  const REF = "native:01J9P0K2N3MZX0YV4S5RTQ4AAA";

  async function seedTodoRepo(ready: boolean): Promise<{ root: string; manifestPath: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cli-bless-"));
    tmpRoots.push(root);
    const todoDir = path.join(root, ".flow", "state", "to-do");
    await fs.mkdir(todoDir, { recursive: true });
    const manifestPath = path.join(todoDir, `${REF}.yaml`);
    const manifest = {
      ref: REF,
      status: "to-do",
      adapter: "native",
      source_path: `.flow/native-stories/${REF}.yaml`,
      source_hash: "a".repeat(64),
      depends_on: [],
      acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
      title: `Test story ${REF}`,
      narrative: "As a dev, I want to test.",
      withdrawn: false,
      ready,
    };
    await fs.writeFile(manifestPath, yamlStringify(manifest, { lineWidth: 0 }), "utf8");
    return { root, manifestPath };
  }

  it("is registered in the CLI TOOLS map", async () => {
    const { stdout } = await runCli(["bogusToolDoesNotExist"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error.known).toContain("markStoryReady");
  });

  it("flips ready false→true on a real to-do manifest (full round-trip)", async () => {
    const { root, manifestPath } = await seedTodoRepo(false);

    const { code, stdout } = await runCli([
      "markStoryReady",
      "--json",
      JSON.stringify({ targetRepoRoot: root, ref: REF, ready: true }),
    ]);

    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.ref).toBe(REF);
    expect(result.ready).toBe(true);
    expect(result.noop).toBe(false);
    expect(result.state).toBe("to-do");

    // The manifest on disk really flipped — proves the tool ran, not just dispatched.
    const after = yamlParse(await fs.readFile(manifestPath, "utf8")) as { ready?: boolean };
    expect(after.ready).toBe(true);
  });

  it("an unknown ref exits 2 with a typed domain error (and mutates nothing)", async () => {
    const { root } = await seedTodoRepo(false);

    const { code, stdout } = await runCli([
      "markStoryReady",
      "--json",
      JSON.stringify({ targetRepoRoot: root, ref: "native:does-not-exist", ready: true }),
    ]);

    expect(code).toBe(2);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error.kind).toBe("domain-error");
    expect(parsed.error.name).toBe("NotAnEligibleBacklogItemError");
  });
});
