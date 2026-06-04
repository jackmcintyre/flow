/**
 * `acceptProposal` gate tests — Story 6.4 AC1–AC6.
 *
 * The gate is exercised end-to-end against real proposal files (seeded via the
 * canonical `writeRetroProposal` writer) with a TEST-INJECTED fake handler and
 * a TEST-INJECTED git-commit seam. No real git, no real handler — the gate is
 * proven against doubles (Story 6.4 ships ONLY the gate machinery; the
 * production registry is empty by design).
 *
 * AC mapping:
 *   - AC1: locator resolves an id to the right file/proposal; ProposalNotFound;
 *     AmbiguousProposalId.
 *   - AC2: preview-only no-op (status preview, diff present, tree unchanged, no
 *     commit, no telemetry).
 *   - AC3: confirmed apply (handler file changed; one commit carrying handler
 *     file + proposal file; applied block with all three fields; status applied
 *     with sha).
 *   - AC4: idempotent re-run (already-applied; no second handler call, write,
 *     commit, or telemetry).
 *   - AC5: exactly one retro.proposal.applied telemetry event on apply; none on
 *     preview.
 *   - AC6: unregistered kind → ProposalKindNotApplicableYetError; tree +
 *     telemetry untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import {
  AmbiguousProposalIdError,
  ProposalCommitFailedError,
  ProposalKindNotApplicableYetError,
} from "../../errors.js";
import { parseRetroProposalFile } from "../../schemas/retro-proposal.js";
import { writeRetroProposal } from "../write-retro-proposal.js";
import { acceptProposal } from "../accept-proposal.js";
import type {
  ProposalApplyHandler,
  ProposalApplyRegistry,
} from "../../lib/proposal-apply-registry.js";
import type { gitCommit as gitCommitType, filterGitIgnoredPaths as filterGitIgnoredPathsType } from "../../lib/git.js";
import type { RetroProposal } from "../../schemas/retro-proposal.js";

// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------

const ULID_RULE = "01HZRETR0000000000000000A1";
const ULID_RULE_2 = "01HZRETR0000000000000000A2";
const ULID_TEAM = "01HZRETR0000000000000000C3";
const ULID_MISSING = "01HZRETR0000000000000000Z9";

const ISO = "2026-05-28T14:32:11.123Z";
const ISO_2 = "2026-05-28T15:00:00.000Z";
const FIXED_NOW = new Date("2026-05-31T10:00:00.000Z");

/**
 * The repo-relative path of the proposal RECORD file for a given ISO timestamp —
 * matches `locateProposal`'s `relPath` (`path.relative(root, .flow/retro-proposals/<iso>.md)`).
 * In a self-host repo where `.flow/` is gitignored this is one of the ignored
 * paths, which is exactly the residual mixed-case bug under test.
 */
function proposalRel(iso: string): string {
  return path.join(".flow", "retro-proposals", `${iso}.md`);
}

function ruleProposal(id: string): Record<string, unknown> {
  return {
    type: "rule",
    id,
    created_at: ISO,
    rationale: "Repeated handoff-grammar fires on this story type.",
    text: "Dev MUST emit the handoff phrase verbatim.",
    target_failure_class: "handoff-grammar",
    recommended_promotion_level: "must",
  };
}

function teamChangeProposal(id: string): Record<string, unknown> {
  return {
    type: "team-change",
    id,
    created_at: ISO,
    rationale: "Repeated security-related verdicts.",
    action: "hire",
    target_role: "security-reviewer",
    justification: "12 fires in the last 10 cycles.",
    predicted_impact: { affected_failure_classes: ["security-audit"] },
  };
}

// ---------------------------------------------------------------------------
// Fake handler + fake git seam
// ---------------------------------------------------------------------------

/** A fake handler plus mutable call counters the tests assert against. */
interface FakeHandler extends ProposalApplyHandler {
  previewCalls: number;
  applyCalls: number;
}

/**
 * A fake apply handler that writes one known file into the target repo and
 * reports it as a changed path. Records its preview/apply call counts so tests
 * can assert "no handler call" branches. The handler's methods mutate the same
 * object the test reads, so the counters stay live (no frozen getters).
 */
function makeFakeHandler(opts: {
  type: RetroProposal["type"];
  changedFileRel: string;
  changedFileContents: string;
  diff: string;
}): FakeHandler {
  const handler: FakeHandler = {
    type: opts.type,
    previewCalls: 0,
    applyCalls: 0,
    async previewDiff() {
      handler.previewCalls++;
      return opts.diff;
    },
    async apply(_proposal, ctx) {
      handler.applyCalls++;
      const abs = path.join(ctx.targetRepoRoot, opts.changedFileRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, opts.changedFileContents, "utf8");
      return { changedPaths: [opts.changedFileRel] };
    },
  };
  return handler;
}

function registryWith(handler: ProposalApplyHandler): ProposalApplyRegistry {
  const map: ProposalApplyRegistry = new Map();
  map.set(handler.type, handler);
  return map;
}

/**
 * A fake git-commit seam recording every call. Returns a deterministic sha.
 */
function makeFakeGitCommit(sha = "deadbeefcafe0000000000000000000000000000") {
  const calls: Array<{ paths: readonly string[]; message: string }> = [];
  const impl = (async (args: {
    paths: readonly string[];
    message: string;
  }) => {
    calls.push({ paths: args.paths, message: args.message });
    return { commitSha: sha, stdout: "", stderr: "" };
  }) as unknown as typeof gitCommitType;
  return { impl, calls };
}

/**
 * A fake `filterGitIgnoredPaths` seam. The caller supplies a set of paths that
 * should be treated as "ignored"; all other paths in the candidate list are
 * returned as tracked.
 */
function makeFakeFilterGitIgnoredPaths(ignoredPaths: readonly string[]) {
  const ignoredSet = new Set(ignoredPaths);
  const impl = (async (opts: { targetRepoRoot: string; paths: readonly string[] }) => {
    return opts.paths.filter((p) => !ignoredSet.has(p));
  }) as unknown as typeof filterGitIgnoredPathsType;
  return impl;
}

// ---------------------------------------------------------------------------
// Tmpdir helpers + telemetry reader
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "accept-proposal-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

/** Read all telemetry events across every .jsonl bucket under .flow/telemetry/. */
async function readTelemetryEvents(): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(tmpRoot, ".flow", "telemetry");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const events: Array<Record<string, unknown>> = [];
  for (const f of files.filter((x) => x.endsWith(".jsonl")).sort()) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

/** Read + parse the proposal file at the given ISO timestamp. */
async function readProposalFile(iso: string) {
  const abs = path.join(tmpRoot, ".flow", "retro-proposals", `${iso}.md`);
  const raw = await fs.readFile(abs, "utf8");
  const rest = raw.slice("---\n".length);
  const closeIdx = rest.indexOf("\n---\n");
  const frontmatter = rest.slice(0, closeIdx + 1);
  const file = parseRetroProposalFile(yamlParse(frontmatter));
  return { abs, raw, file };
}

// ---------------------------------------------------------------------------
// AC1 — locator
// ---------------------------------------------------------------------------

describe("acceptProposal — locator (AC1)", () => {
  beforeEach(async () => {
    // Seed two proposal files with several proposals.
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE), teamChangeProposal(ULID_TEAM)],
    });
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO_2,
      proposals: [ruleProposal(ULID_RULE_2)],
    });
  });

  it("resolves a known id to the right file and proposal (via preview path)", async () => {
    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: "docs/discipline-rules.yaml",
      changedFileContents: "rules: []\n",
      diff: "DIFF-FOR-RULE-2",
    });
    // Target the proposal that lives ONLY in the second file.
    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE_2,
      handlers: registryWith(handler),
    });
    expect(result.status).toBe("preview");
    if (result.status === "preview") {
      expect(result.proposalId).toBe(ULID_RULE_2);
      expect(result.type).toBe("rule");
      expect(result.diff).toBe("DIFF-FOR-RULE-2");
    }
  });

  it("raises ProposalNotFoundError for an unknown id, naming files scanned", async () => {
    await expect(
      acceptProposal({ targetRepoRoot: tmpRoot, proposalId: ULID_MISSING }),
    ).rejects.toMatchObject({
      name: "ProposalNotFoundError",
      proposalId: ULID_MISSING,
      filesScanned: 2,
    });
  });

  it("raises ProposalNotFoundError (0 scanned) when the proposals dir is absent", async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "accept-empty-"));
    try {
      await expect(
        acceptProposal({ targetRepoRoot: emptyRoot, proposalId: ULID_RULE }),
      ).rejects.toMatchObject({
        name: "ProposalNotFoundError",
        filesScanned: 0,
      });
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("raises AmbiguousProposalIdError when the same id appears in two files", async () => {
    // Seed a third file re-using ULID_RULE (which already lives in the ISO file).
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: "2026-05-28T16:00:00.000Z",
      proposals: [ruleProposal(ULID_RULE)],
    });
    await expect(
      acceptProposal({ targetRepoRoot: tmpRoot, proposalId: ULID_RULE }),
    ).rejects.toBeInstanceOf(AmbiguousProposalIdError);
  });
});

// ---------------------------------------------------------------------------
// AC2 — preview-only no-op
// ---------------------------------------------------------------------------

describe("acceptProposal — preview is a no-op (AC2, AC5)", () => {
  it("returns preview + diff, writes no file, makes no commit, emits no telemetry, leaves the tree byte-identical", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE)],
    });
    const beforeProposal = await readProposalFile(ISO);
    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: "docs/discipline-rules.yaml",
      changedFileContents: "rules: [one]\n",
      diff: "+ a new rule line\n",
    });
    const git = makeFakeGitCommit();

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      // confirm omitted → preview mode
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("preview");
    if (result.status === "preview") {
      expect(result.diff).toBe("+ a new rule line\n");
    }

    // No handler apply, no commit.
    expect(handler.applyCalls).toBe(0);
    expect(handler.previewCalls).toBe(1);
    expect(git.calls).toHaveLength(0);

    // Handler's target file was never written.
    await expect(
      fs.access(path.join(tmpRoot, "docs", "discipline-rules.yaml")),
    ).rejects.toThrow();

    // Proposal file byte-identical (no applied stamp).
    const afterProposal = await readProposalFile(ISO);
    expect(afterProposal.raw).toBe(beforeProposal.raw);
    expect(afterProposal.file.proposals[0]!.applied).toBeUndefined();

    // No telemetry.
    expect(await readTelemetryEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 + AC5 — confirmed apply
// ---------------------------------------------------------------------------

describe("acceptProposal — confirmed apply (AC3, AC5)", () => {
  it("applies, commits handler file + proposal file in one commit, stamps applied, emits one event", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE), teamChangeProposal(ULID_TEAM)],
    });
    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: "docs/discipline-rules.yaml",
      changedFileContents: "rules:\n  - the new rule\n",
      diff: "+ the new rule\n",
    });
    const git = makeFakeGitCommit("aabbccddeeff00112233445566778899aabbccdd");
    // No paths are ignored — all handler paths are tracked.
    const filterIgnored = makeFakeFilterGitIgnoredPaths([]);

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => FIXED_NOW,
    });

    // Status + sha.
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.appliedSha).toBe(
        "aabbccddeeff00112233445566778899aabbccdd",
      );
      expect(result.idempotencyKey).toBe(ULID_RULE);
      expect(result.type).toBe("rule");
    }

    // Handler file changed on disk.
    const handlerFile = await fs.readFile(
      path.join(tmpRoot, "docs", "discipline-rules.yaml"),
      "utf8",
    );
    expect(handlerFile).toBe("rules:\n  - the new rule\n");

    // Exactly one commit, carrying BOTH the handler file and the proposal file.
    expect(git.calls).toHaveLength(1);
    const committed = git.calls[0]!;
    expect(committed.message).toBe(`accept-proposal: ${ULID_RULE}`);
    expect(committed.paths).toContain("docs/discipline-rules.yaml");
    expect(
      committed.paths.some((p) => p.endsWith(`${ISO}.md`)),
    ).toBe(true);

    // Proposal now has an applied block with all three fields.
    const after = await readProposalFile(ISO);
    const applied = after.file.proposals[0]!.applied;
    expect(applied).toBeDefined();
    expect(applied!.applied_at).toBe(FIXED_NOW.toISOString());
    expect(applied!.applied_sha).toBe(
      "aabbccddeeff00112233445566778899aabbccdd",
    );
    expect(applied!.idempotency_key).toBe(ULID_RULE);

    // The OTHER proposal in the file is untouched (no applied block).
    expect(after.file.proposals[1]!.id).toBe(ULID_TEAM);
    expect(after.file.proposals[1]!.applied).toBeUndefined();

    // Exactly one retro.proposal.applied event with the right fields.
    const events = await readTelemetryEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("retro.proposal.applied");
    expect(ev.data).toMatchObject({
      id: ULID_RULE,
      proposal_type: "rule",
      applied_sha: "aabbccddeeff00112233445566778899aabbccdd",
      idempotency_key: ULID_RULE,
    });
  });

  it("keeps the applied stamp (uncommitted sentinel) + raises ProposalCommitFailedError when the commit fails, so a re-run is a no-op", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE)],
    });
    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: "docs/discipline-rules.yaml",
      changedFileContents: "rules: [x]\n",
      diff: "d",
    });
    const failingGit = (async () => {
      throw new Error("git commit boom");
    }) as unknown as typeof gitCommitType;
    // No paths are ignored — we want the commit to be attempted (and fail).
    const filterIgnored = makeFakeFilterGitIgnoredPaths([]);

    // The apply lands on disk + stamps, then the commit throws → a structured
    // ProposalCommitFailedError that names the proposal id.
    await expect(
      acceptProposal({
        targetRepoRoot: tmpRoot,
        proposalId: ULID_RULE,
        confirm: true,
        handlers: registryWith(handler),
        gitCommitImpl: failingGit,
        filterGitIgnoredPathsImpl: filterIgnored,
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({
      name: "ProposalCommitFailedError",
      proposalId: ULID_RULE,
    });

    // The handler change is on disk (it ran before the failed commit).
    expect(
      await fs.readFile(
        path.join(tmpRoot, "docs", "discipline-rules.yaml"),
        "utf8",
      ),
    ).toBe("rules: [x]\n");

    // Stamp is KEPT — applied block present with the "uncommitted" sentinel sha
    // (non-idempotent handlers must not re-apply, so the stamp is not rolled back).
    const after = await readProposalFile(ISO);
    expect(after.file.proposals[0]!.applied).toBeDefined();
    expect(after.file.proposals[0]!.applied!.applied_sha).toBe("uncommitted");
    expect(after.file.proposals[0]!.applied!.applied_at).toBe(
      FIXED_NOW.toISOString(),
    );

    // No telemetry on a failed commit.
    expect(await readTelemetryEvents()).toHaveLength(0);

    // Re-run is a safe no-op: the idempotency check sees the stamp and returns
    // already-applied without calling the handler or git again.
    const second = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: failingGit,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(second.status).toBe("already-applied");
    expect(handler.applyCalls).toBe(1);
    expect(await readTelemetryEvents()).toHaveLength(0);
    // The error message points the operator at committing manually.
    const err = new ProposalCommitFailedError({
      proposalId: ULID_RULE,
      paths: ["docs/discipline-rules.yaml"],
      underlyingMessage: "git commit boom",
    });
    expect(err.message).toContain("Commit the change by hand");
    expect(err.message).toContain("docs/discipline-rules.yaml");
  });
});

// ---------------------------------------------------------------------------
// AC4 — idempotent re-run
// ---------------------------------------------------------------------------

describe("acceptProposal — idempotent re-run (AC4)", () => {
  it("a second confirmed call reports already-applied, mutating nothing", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE)],
    });
    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: "docs/discipline-rules.yaml",
      changedFileContents: "rules:\n  - r\n",
      diff: "d",
    });
    const git = makeFakeGitCommit("11112222333344445555666677778888999900aa");
    // No paths are ignored — all handler paths are tracked.
    const filterIgnored = makeFakeFilterGitIgnoredPaths([]);

    // First apply.
    const first = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => FIXED_NOW,
    });
    expect(first.status).toBe("applied");
    const firstSha =
      first.status === "applied" ? first.appliedSha : "<none>";

    const afterFirst = await readProposalFile(ISO);

    // Second call on the same id — even with confirm: true.
    const second = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(second.status).toBe("already-applied");
    if (second.status === "already-applied") {
      expect(second.appliedSha).toBe(firstSha);
      expect(second.appliedAt).toBe(FIXED_NOW.toISOString());
    }

    // No second handler call, no second commit.
    expect(handler.applyCalls).toBe(1);
    expect(git.calls).toHaveLength(1);

    // Proposal file unchanged since the first apply.
    const afterSecond = await readProposalFile(ISO);
    expect(afterSecond.raw).toBe(afterFirst.raw);

    // Still exactly one telemetry event (no second emit).
    expect(await readTelemetryEvents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC6 — unregistered kind fails closed
// ---------------------------------------------------------------------------

describe("acceptProposal — unregistered kind fails closed (AC6)", () => {
  it("raises ProposalKindNotApplicableYetError, leaving tree + telemetry untouched", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [teamChangeProposal(ULID_TEAM)],
    });
    const before = await readProposalFile(ISO);
    const git = makeFakeGitCommit();

    // No handlers passed → production registry is empty → fails closed.
    await expect(
      acceptProposal({
        targetRepoRoot: tmpRoot,
        proposalId: ULID_TEAM,
        confirm: true,
        gitCommitImpl: git.impl,
      }),
    ).rejects.toBeInstanceOf(ProposalKindNotApplicableYetError);

    // Error names the kind and its planned story.
    await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_TEAM,
      confirm: true,
      gitCommitImpl: git.impl,
    }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(ProposalKindNotApplicableYetError);
      const e = err as ProposalKindNotApplicableYetError;
      expect(e.kind).toBe("team-change");
      expect(e.story).toBe("Story 6.10");
    });

    // Nothing committed, proposal byte-identical, no telemetry.
    expect(git.calls).toHaveLength(0);
    const after = await readProposalFile(ISO);
    expect(after.raw).toBe(before.raw);
    expect(after.file.proposals[0]!.applied).toBeUndefined();
    expect(await readTelemetryEvents()).toHaveLength(0);
  });

  it("does not even render a preview for an unregistered kind", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [teamChangeProposal(ULID_TEAM)],
    });
    // Preview mode (confirm omitted) on an unregistered kind still fails closed.
    await expect(
      acceptProposal({ targetRepoRoot: tmpRoot, proposalId: ULID_TEAM }),
    ).rejects.toBeInstanceOf(ProposalKindNotApplicableYetError);
  });
});

// ---------------------------------------------------------------------------
// AC1 (new) — git-ignored target files: completes, stamps, re-run is no-op
// ---------------------------------------------------------------------------

describe("acceptProposal — git-ignored target files (AC1 new)", () => {
  it("completes without error, writes the disk change, stamps the proposal, and a re-run is a no-op when all handler paths are git-ignored", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE)],
    });

    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: "ignored-output/rules.yaml",
      changedFileContents: "rules: [ignored]\n",
      diff: "d",
    });
    const git = makeFakeGitCommit();
    // The handler path AND the proposal record file are both ignored (the
    // self-host shape where all of .flow/ is gitignored) — no tracked paths to
    // commit, so the no-commit branch fires.
    const filterIgnored = makeFakeFilterGitIgnoredPaths([
      "ignored-output/rules.yaml",
      proposalRel(ISO),
    ]);

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => FIXED_NOW,
    });

    // Apply completes without error.
    expect(result.status).toBe("applied");

    // The disk change was written.
    const written = await fs.readFile(
      path.join(tmpRoot, "ignored-output", "rules.yaml"),
      "utf8",
    );
    expect(written).toBe("rules: [ignored]\n");

    // No commit was made (nothing tracked to commit).
    expect(git.calls).toHaveLength(0);

    // Proposal is stamped as applied.
    const after = await readProposalFile(ISO);
    expect(after.file.proposals[0]!.applied).toBeDefined();
    expect(after.file.proposals[0]!.applied!.applied_at).toBe(FIXED_NOW.toISOString());

    // Telemetry was still emitted.
    const events = await readTelemetryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("retro.proposal.applied");

    // Re-run: second call exits as already-applied, changes nothing.
    const second = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(second.status).toBe("already-applied");
    // Handler was called only once (first run), not on the re-run.
    expect(handler.applyCalls).toBe(1);
    // Still no git commits.
    expect(git.calls).toHaveLength(0);
    // Still exactly one telemetry event.
    expect(await readTelemetryEvents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC2 (new) — mixed tracked/ignored paths: only tracked subset is committed
// ---------------------------------------------------------------------------

describe("acceptProposal — mixed tracked and ignored paths (AC2 new)", () => {
  it("commits only the tracked subset, silently skipping the ignored paths without error", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE)],
    });

    // Handler returns two paths: one tracked, one ignored.
    const trackedRel = "docs/tracked-rules.yaml";
    const ignoredRel = "ignored-output/ignored-rules.yaml";

    const handler: ProposalApplyHandler = {
      type: "rule",
      async previewDiff() {
        return "d";
      },
      async apply(_proposal, ctx) {
        for (const rel of [trackedRel, ignoredRel]) {
          const abs = path.join(ctx.targetRepoRoot, rel);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, `contents of ${rel}\n`, "utf8");
        }
        return { changedPaths: [trackedRel, ignoredRel] };
      },
    };
    const git = makeFakeGitCommit("cafebabe0000000000000000000000000000cafe");
    // Only the ignoredRel path is ignored; trackedRel is tracked.
    const filterIgnored = makeFakeFilterGitIgnoredPaths([ignoredRel]);

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("applied");

    // Both files were written to disk.
    for (const rel of [trackedRel, ignoredRel]) {
      const content = await fs.readFile(path.join(tmpRoot, rel), "utf8");
      expect(content).toBe(`contents of ${rel}\n`);
    }

    // Exactly one commit was made.
    expect(git.calls).toHaveLength(1);
    const committed = git.calls[0]!;

    // The commit includes the tracked path and the proposal file.
    expect(committed.paths).toContain(trackedRel);
    expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(true);

    // The ignored path was NOT committed.
    expect(committed.paths).not.toContain(ignoredRel);

    // Proposal is stamped with the real commit sha.
    const after = await readProposalFile(ISO);
    expect(after.file.proposals[0]!.applied?.applied_sha).toBe(
      "cafebabe0000000000000000000000000000cafe",
    );
  });

  it("commits only the tracked handler path, filtering out the IGNORED proposal record file (self-host mixed case)", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE)],
    });

    const trackedRel = "docs/tracked-rules.yaml";
    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: trackedRel,
      changedFileContents: "rules:\n  - r\n",
      diff: "d",
    });
    const git = makeFakeGitCommit("0badf00d0000000000000000000000000000beef");
    // The handler path is tracked, but the proposal RECORD file is ignored —
    // the residual bug: previously the record file was appended to the commit
    // unfiltered and `git add <ignored>` would reject it.
    const filterIgnored = makeFakeFilterGitIgnoredPaths([proposalRel(ISO)]);

    const result = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("applied");

    // Exactly one commit, carrying ONLY the tracked handler path.
    expect(git.calls).toHaveLength(1);
    const committed = git.calls[0]!;
    expect(committed.paths).toContain(trackedRel);
    // git never received the ignored record file.
    expect(committed.paths.some((p) => p.endsWith(`${ISO}.md`))).toBe(false);
    expect(committed.paths).not.toContain(proposalRel(ISO));

    // Proposal is still stamped with the real commit sha.
    const after = await readProposalFile(ISO);
    expect(after.file.proposals[0]!.applied?.applied_sha).toBe(
      "0badf00d0000000000000000000000000000beef",
    );
  });

  it("already-stamped proposal exits cleanly without re-applying", async () => {
    await writeRetroProposal({
      targetRepoRoot: tmpRoot,
      isoTimestamp: ISO,
      proposals: [ruleProposal(ULID_RULE)],
    });

    const handler = makeFakeHandler({
      type: "rule",
      changedFileRel: "docs/rules.yaml",
      changedFileContents: "rules: [r]\n",
      diff: "d",
    });
    const git = makeFakeGitCommit("1111222233334444555566667777888899990000");
    const filterIgnored = makeFakeFilterGitIgnoredPaths([]);

    // First confirmed apply stamps the proposal.
    const first = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => FIXED_NOW,
    });
    expect(first.status).toBe("applied");

    const afterFirst = await readProposalFile(ISO);
    expect(afterFirst.file.proposals[0]!.applied).toBeDefined();

    // Second call with confirm: true detects the stamp and exits cleanly.
    const second = await acceptProposal({
      targetRepoRoot: tmpRoot,
      proposalId: ULID_RULE,
      confirm: true,
      handlers: registryWith(handler),
      gitCommitImpl: git.impl,
      filterGitIgnoredPathsImpl: filterIgnored,
      now: () => new Date("2099-06-01T00:00:00.000Z"),
    });

    expect(second.status).toBe("already-applied");
    // Handler was called only once; no second git commit.
    expect(handler.applyCalls).toBe(1);
    expect(git.calls).toHaveLength(1);

    // Proposal file unchanged since first apply.
    const afterSecond = await readProposalFile(ISO);
    expect(afterSecond.raw).toBe(afterFirst.raw);
  });
});