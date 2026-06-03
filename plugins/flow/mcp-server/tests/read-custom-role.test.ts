/**
 * Story 2.5 — `readCustomRole` MCP tool unit tests.
 *
 * Covers the contract pinned in Task 1 of
 * `_bmad-output/implementation-artifacts/2-5-skip-hiring-fast-path-and-custom-escape-hatch.md`:
 *
 *   - ENOENT → CatalogueRoleNotFoundError
 *   - malformed file → CatalogueShapeError (via parseCatalogueRole)
 *   - valid file → CatalogueRole whose sections.Prompt is byte-for-byte
 *   - role id failing kebab-case (e.g. "../planner") → rejected at the
 *     function boundary before any IO
 *   - filename ↔ frontmatter role mismatch → CatalogueShapeError
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric (Story 1.8 convention). This file is NOT user-surface — these
 * are unit tests for an internal MCP tool.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readCustomRole } from "../src/tools/read-custom-role.js";
import {
  CatalogueRoleNotFoundError,
  CatalogueShapeError,
} from "../src/errors.js";
import { parseCatalogueRole } from "../src/lib/markdown-frontmatter.js";

const VALID_BODY = `---
role: data-scientist
domain: "ml pipeline ownership"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — <intent>"
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
---

# Data scientist

## Domain

Owns the ML pipeline so generalist-dev does not have to learn pandas.

## Mandate

- Author training scripts, model evaluation, and inference glue.
- Surface dataset shape changes to the planner before the dev loop wakes.

## Out of mandate

- Production deploys (orchestrator owns).
- Reviewing non-ML code (generalist-reviewer owns).

## Prompt

You are the data scientist. Read the dataset, propose the model, train it, evaluate, write the inference glue. Stay terse.
`;

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `flow-rcr-${prefix}-`));
  tmpDirs.push(tmp);
  return tmp;
}

async function writeCustom(
  root: string,
  filename: string,
  body: string,
): Promise<string> {
  const customDir = path.join(root, "team", "custom");
  await fs.mkdir(customDir, { recursive: true });
  const filePath = path.join(customDir, filename);
  await fs.writeFile(filePath, body, "utf8");
  return filePath;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("Story 2.5 — readCustomRole", () => {
  it("(a) throws CatalogueRoleNotFoundError when the file is absent", async () => {
    const root = await makeTmp("missing");
    await expect(
      readCustomRole({ targetRepoRoot: root, role: "data-scientist" }),
    ).rejects.toBeInstanceOf(CatalogueRoleNotFoundError);
  });

  it("(b) throws CatalogueShapeError when the file is malformed (missing ## Out of mandate)", async () => {
    const root = await makeTmp("malformed");
    const malformed = VALID_BODY.replace(
      /## Out of mandate[\s\S]*?(?=## Prompt)/,
      "",
    );
    const filePath = await writeCustom(root, "data-scientist.md", malformed);

    let caught: unknown;
    try {
      await readCustomRole({ targetRepoRoot: root, role: "data-scientist" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogueShapeError);
    expect((caught as CatalogueShapeError).message).toContain(filePath);
  });

  it("(c) returns a CatalogueRole whose sections.Prompt matches the source byte-for-byte", async () => {
    const root = await makeTmp("valid");
    const filePath = await writeCustom(root, "data-scientist.md", VALID_BODY);
    const result = await readCustomRole({
      targetRepoRoot: root,
      role: "data-scientist",
    });
    expect(result.role).toBe("data-scientist");
    expect(result.domain).toBe("ml pipeline ownership");
    expect(result.sourcePath).toBe(filePath);

    // Cross-check Prompt byte-equality via the same parser.
    const direct = parseCatalogueRole(VALID_BODY, filePath);
    expect(result.sections.Prompt).toBe(direct.sections.Prompt);
  });

  it("(d) rejects path-traversal role ids at the function boundary", async () => {
    const root = await makeTmp("traversal");
    await expect(
      readCustomRole({ targetRepoRoot: root, role: "../planner" }),
    ).rejects.toBeInstanceOf(CatalogueShapeError);
    // No file is opened — even before we write anything.
    await expect(
      readCustomRole({ targetRepoRoot: root, role: "Foo" }),
    ).rejects.toBeInstanceOf(CatalogueShapeError);
  });

  it("(e) throws CatalogueShapeError when filename does not match frontmatter role", async () => {
    const root = await makeTmp("mismatch");
    // VALID_BODY has frontmatter `role: data-scientist`. Write under a
    // file named `kubernetes-expert.md` — the kebab-case regex passes
    // (the *filename* basename is valid kebab-case), but the parser
    // returns role='data-scientist' which does not match the requested
    // role id `kubernetes-expert`.
    await writeCustom(root, "kubernetes-expert.md", VALID_BODY);
    let caught: unknown;
    try {
      await readCustomRole({
        targetRepoRoot: root,
        role: "kubernetes-expert",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogueShapeError);
    expect((caught as CatalogueShapeError).message).toContain(
      "frontmatter role 'data-scientist' does not match filename 'kubernetes-expert'",
    );
  });
});
