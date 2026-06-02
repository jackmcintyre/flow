/**
 * Integration tests for the recoverable-error path.
 *
 * Covers AC3b–AC3g, AC3j, AC3k from Story 4.5 (eight scenarios total).
 *
 * Uses a real tmpdir with `git init`, an in-progress manifest, and a fixture
 * spec. Injects `execaImpl` stub into `runDevTerminalAction` to control `gh`
 * exit codes/stderrs, and drives `processDevTranscript` with synthetic
 * transcripts to verify manifest stamping.
 *
 * The integration test does NOT actually invoke `runDevTerminalAction` to
 * produce a GhRecoverableError and then feed that transcript through
 * processDevTranscript in a single call, because runDevTerminalAction raises
 * and the dev subagent is the entity that produces the transcript. Instead,
 * each scenario:
 * 1. Verifies the gh() wrapper raises GhRecoverableError with the right class.
 * 2. Verifies processDevTranscript with a synthetic transcript (the locked line
 *    the dev subagent would emit) stamps blocked_by and returns the right `next`.
 * 3. Asserts the manifest is still in `in-progress/` (never moved/deleted).
 *
 * @see _bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md § Behavioural contract
 *
 * Story 4.5 Task 6.1–6.5
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { gh } from "../../lib/gh.js";
import { processDevTranscript } from "../process-dev-transcript.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { GhRecoverableError, GhPrCreateFailedError } from "../../errors.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import type { RolePermissions } from "../../schemas/role-permissions.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_REF = "4-5-gh-recoverable-integration";
const SESSION_ULID = "01HZINTEGRATION000000000001";

/** v1 gh-error-map.yaml content (same rows as shipped file). */
const V1_ERROR_MAP = `\
entries:
  - exit_code: 4
    stderr_regex: "requires authentication|gh auth login"
    class: needs-human
  - exit_code: 4
    stderr_regex: "API rate limit exceeded|secondary rate limit"
    class: defer
  - exit_code: 1
    stderr_regex: "dial tcp|connection reset|could not resolve host|i/o timeout|network is unreachable"
    class: retry
`;

const FIXTURE_PERSONA_MD = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Dev

## Domain
Feature implementation.

## Mandate
- Implement stories.

## Out of mandate
- Reviewing.

## Prompt
You are the generalist dev.

## Knowledge
No knowledge yet.
`;

const FIXTURE_REVIEWER_PERSONA_MD = `---
role: generalist-reviewer
domain: "code review in a story scope"
model_tier: sonnet
tools_allow:
  - Read
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Reviewer

## Domain
Code review.

## Mandate
- Review stories.

## Out of mandate
- Implementing.

## Prompt
You are the generalist reviewer.

## Knowledge
No knowledge yet.
`;

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

interface TestContext {
  repoRoot: string;
  manifestPath: string;
  fakePluginRoot: string;
  permissions: RolePermissions;
}

let ctx: TestContext;

beforeEach(async () => {
  __resetGhErrorMapCacheForTests();

  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gh-recoverable-"));

  // git init (needed for runDevTerminalAction; also ensures .crew/ dir is usable)
  await realExeca("git", ["-C", repoRoot, "init"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.email", "test@test.com"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);

  // Seed initial commit
  await atomicWriteFile(path.join(repoRoot, "README.md"), "# Test\n");
  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: initial commit"]);

  // Create in-progress manifest
  const stateDir = path.join(repoRoot, ".flow", "state", "in-progress");
  await fs.mkdir(stateDir, { recursive: true });
  const manifestPath = path.join(stateDir, `${STORY_REF}.yaml`);

  const manifest = {
    ref: STORY_REF,
    status: "in-progress",
    adapter: "bmad",
    source_path: `_bmad-output/implementation-artifacts/${STORY_REF}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [
      { text: "Given x, when y, then z.", kind: "integration" },
    ],
    title: "Integration test for gh recoverable error",
    narrative: "As a dev, I want recoverable gh errors handled.",
    withdrawn: false,
    claimed_by: SESSION_ULID,
  };
  await atomicWriteFile(manifestPath, yamlStringify(manifest, { lineWidth: 0 }));

  // Create fake plugin root with v1 error map
  const fakePluginRoot = path.join(repoRoot, "_plugin");
  await fs.mkdir(path.join(fakePluginRoot, "permissions"), { recursive: true });
  await atomicWriteFile(
    path.join(fakePluginRoot, "permissions", "gh-error-map.yaml"),
    V1_ERROR_MAP,
  );

  // Team persona dirs (needed for processDevTranscript happy path)
  await fs.mkdir(path.join(repoRoot, "team", "generalist-dev"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "team", "generalist-reviewer"), { recursive: true });
  await atomicWriteFile(
    path.join(repoRoot, "team", "generalist-dev", "PERSONA.md"),
    FIXTURE_PERSONA_MD,
  );
  await atomicWriteFile(
    path.join(repoRoot, "team", "generalist-reviewer", "PERSONA.md"),
    FIXTURE_REVIEWER_PERSONA_MD,
  );

  const permissions: RolePermissions = {
    role: "generalist-dev",
    tools_allow: ["runDevTerminalAction"],
    gh_allow: ["pr-create"],
    gh_allow_args: {},
    sourcePath: path.join(fakePluginRoot, "permissions", "generalist-dev.yaml"),
  };

  ctx = { repoRoot, manifestPath, fakePluginRoot, permissions };
});

afterEach(async () => {
  __resetGhErrorMapCacheForTests();
  await fs.rm(ctx.repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: read manifest from disk
// ---------------------------------------------------------------------------

async function readManifestFromDisk() {
  const raw = await fs.readFile(ctx.manifestPath, "utf8");
  return parseExecutionManifest(yamlParse(raw) as unknown, { absPath: ctx.manifestPath });
}

// ---------------------------------------------------------------------------
// Helper: assert manifest is still in in-progress dir
// ---------------------------------------------------------------------------

async function assertManifestInInProgress() {
  await expect(fs.access(ctx.manifestPath)).resolves.toBeUndefined();
  const blockedPath = ctx.manifestPath.replace("/in-progress/", "/blocked/");
  await expect(fs.access(blockedPath)).rejects.toThrow();
}

// ---------------------------------------------------------------------------
// Helper: make gh stub
// ---------------------------------------------------------------------------

function makeGhStub(exitCode: number, stderr: string, stdout = "") {
  return async (cmd: string, args: string[]) => {
    if (cmd === "gh") {
      return { stdout, stderr, exitCode };
    }
    // delegate real git
    const r = await realExeca(cmd, args, { reject: false });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
}

// ---------------------------------------------------------------------------
// AC3b — defer class
// ---------------------------------------------------------------------------

describe("AC3b — defer class", () => {
  it("(i) gh() raises GhRecoverableError class=defer; (iii) manifest carries blocked_by=gh-defer; (iv) still in in-progress/", async () => {
    // (i) Verify wrapper raises GhRecoverableError
    const stub = async () => ({
      stdout: "",
      stderr: "API rate limit exceeded",
      exitCode: 4,
    });

    const err = await gh({
      role: "generalist-dev",
      permissions: ctx.permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: ctx.fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("defer");

    // (ii) processDevTranscript with locked line
    const result = await processDevTranscript({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: "gh-recoverable: class=defer subcommand=pr-create exit=4",
    });

    // next literal
    expect(result.next).toBe("done-blocked-gh-defer");

    // (iii) manifest blocked_by
    const manifest = await readManifestFromDisk();
    expect(manifest.blocked_by).toBe("gh-defer");

    // (iv) still in in-progress/
    await assertManifestInInProgress();

    // (v) chat line shape
    expect(result.chatLog[0]).toBe(
      `gh recoverable error (class=defer) — story ${STORY_REF} blocked. blocked_by stamped to gh-defer. Operator action: wait and re-run /flow:start`,
    );
  });
});

// ---------------------------------------------------------------------------
// AC3c — needs-human class
// ---------------------------------------------------------------------------

describe("AC3c — needs-human class", () => {
  it("(i) gh() raises GhRecoverableError class=needs-human; (iii) blocked_by=gh-needs-human; (iv) still in in-progress/", async () => {
    const stub = async () => ({
      stdout: "",
      stderr: "gh auth login required",
      exitCode: 4,
    });

    const err = await gh({
      role: "generalist-dev",
      permissions: ctx.permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: ctx.fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("needs-human");

    const result = await processDevTranscript({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: "gh-recoverable: class=needs-human subcommand=pr-create exit=4",
    });

    expect(result.next).toBe("done-blocked-gh-needs-human");

    const manifest = await readManifestFromDisk();
    expect(manifest.blocked_by).toBe("gh-needs-human");

    await assertManifestInInProgress();

    expect(result.chatLog[0]).toBe(
      `gh recoverable error (class=needs-human) — story ${STORY_REF} blocked. blocked_by stamped to gh-needs-human. Operator action: run \`gh auth login\` then re-run /flow:start`,
    );
  });
});

// ---------------------------------------------------------------------------
// AC3d — retry class
// ---------------------------------------------------------------------------

describe("AC3d — retry class", () => {
  it("(i) gh() raises GhRecoverableError class=retry; (iii) blocked_by=gh-retry; (iv) still in in-progress/", async () => {
    const stub = async () => ({
      stdout: "",
      stderr: "dial tcp: lookup api.github.com: i/o timeout",
      exitCode: 1,
    });

    const err = await gh({
      role: "generalist-dev",
      permissions: ctx.permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: ctx.fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("retry");

    const result = await processDevTranscript({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: "gh-recoverable: class=retry subcommand=pr-create exit=1",
    });

    expect(result.next).toBe("done-blocked-gh-retry");

    const manifest = await readManifestFromDisk();
    expect(manifest.blocked_by).toBe("gh-retry");

    await assertManifestInInProgress();

    expect(result.chatLog[0]).toBe(
      `gh recoverable error (class=retry) — story ${STORY_REF} blocked. blocked_by stamped to gh-retry. Operator action: transient network error; re-run /flow:start (v2 will auto-retry)`,
    );
  });
});

// ---------------------------------------------------------------------------
// AC3e — unmapped failure stays terminal
// ---------------------------------------------------------------------------

describe("AC3e — unmapped failure stays terminal", () => {
  it("(i) gh() does NOT raise GhRecoverableError; (ii) existing terminal path taken; (iii) manifest has no gh-* blocked_by", async () => {
    const stub = async () => ({
      stdout: "",
      stderr: "pull request already exists for branch",
      exitCode: 1,
    });

    const result = await gh({
      role: "generalist-dev",
      permissions: ctx.permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: ctx.fakePluginRoot,
    });

    // (i) No GhRecoverableError — wrapper returns raw result
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("pull request already exists for branch");

    // (iii) Manifest has no blocked_by at all (never stamped by the wrapper)
    const manifest = await readManifestFromDisk();
    expect(manifest.blocked_by).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3f — match precedence (ordering)
// ---------------------------------------------------------------------------

describe("AC3f — match precedence (ordering)", () => {
  it("needs-human auth row before defer rate-limit row: auth stderr → needs-human, rate-limit stderr → defer", async () => {
    // Use a fixture map with needs-human BEFORE defer (same as shipped v1)
    const fixtureMap = `
entries:
  - exit_code: 4
    stderr_regex: "requires authentication|gh auth login"
    class: needs-human
  - exit_code: 4
    stderr_regex: "API rate limit exceeded|secondary rate limit"
    class: defer
`;
    await atomicWriteFile(
      path.join(ctx.fakePluginRoot, "permissions", "gh-error-map.yaml"),
      fixtureMap,
    );
    __resetGhErrorMapCacheForTests();

    const authStub = async () => ({
      stdout: "",
      stderr: "requires authentication",
      exitCode: 4,
    });

    const authErr = await gh({
      role: "generalist-dev",
      permissions: ctx.permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: authStub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: ctx.fakePluginRoot,
    }).catch((e) => e);

    expect(authErr).toBeInstanceOf(GhRecoverableError);
    expect((authErr as GhRecoverableError).class).toBe("needs-human");

    __resetGhErrorMapCacheForTests();

    const rateStub = async () => ({
      stdout: "",
      stderr: "API rate limit exceeded",
      exitCode: 4,
    });

    const rateErr = await gh({
      role: "generalist-dev",
      permissions: ctx.permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: rateStub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: ctx.fakePluginRoot,
    }).catch((e) => e);

    expect(rateErr).toBeInstanceOf(GhRecoverableError);
    expect((rateErr as GhRecoverableError).class).toBe("defer");
  });
});

// ---------------------------------------------------------------------------
// AC3g — optional stderr_regex
// ---------------------------------------------------------------------------

describe("AC3g — optional stderr_regex (exit_code-only match)", () => {
  it("entry with no regex matches any stderr for that exit_code", async () => {
    const fixtureMap = `
entries:
  - exit_code: 99
    class: defer
`;
    await atomicWriteFile(
      path.join(ctx.fakePluginRoot, "permissions", "gh-error-map.yaml"),
      fixtureMap,
    );
    __resetGhErrorMapCacheForTests();

    const stub = async () => ({
      stdout: "",
      stderr: "whatever error text",
      exitCode: 99,
    });

    const err = await gh({
      role: "generalist-dev",
      permissions: ctx.permissions,
      subcommand: "pr-create",
      args: [],
      execaImpl: stub as unknown as Parameters<typeof gh>[0]["execaImpl"],
      pluginRootOverride: ctx.fakePluginRoot,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GhRecoverableError);
    expect((err as GhRecoverableError).class).toBe("defer");
  });
});

// ---------------------------------------------------------------------------
// AC3j — locked-phrase drift falls through to handoff-grammar
// ---------------------------------------------------------------------------

describe("AC3j — locked-phrase drift falls through to handoff-grammar", () => {
  it("paraphrased marker → manifest carries handoff-grammar, not any gh-* value", async () => {
    const result = await processDevTranscript({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: "gh recoverable error: defer",  // paraphrase — no match
    });

    expect(result.next).toBe("done-blocked-handoff-grammar");

    const manifest = await readManifestFromDisk();
    expect(manifest.blocked_by).toBe("handoff-grammar");
    expect(manifest.blocked_by).not.toMatch(/^gh-/);
  });
});

// ---------------------------------------------------------------------------
// AC3k — recoverable + handoff coexistence
// ---------------------------------------------------------------------------

describe("AC3k — recoverable + handoff coexistence: recoverable wins", () => {
  it("transcript with BOTH locked recoverable line AND handoff phrase → recoverable wins", async () => {
    const handoffPhrase = `Handoff to reviewer — story ${STORY_REF} ready for review.`;
    const transcript =
      `gh-recoverable: class=defer subcommand=pr-create exit=4\n` + handoffPhrase;

    const result = await processDevTranscript({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: transcript,
    });

    expect(result.next).toBe("done-blocked-gh-defer");

    const manifest = await readManifestFromDisk();
    expect(manifest.blocked_by).toBe("gh-defer");

    // Manifest still in in-progress/
    await assertManifestInInProgress();
  });
});
