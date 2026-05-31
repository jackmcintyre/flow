import { afterAll, describe, expect, it } from "vitest";
import { promises as fs, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { writeManagedFile } from "../src/lib/managed-fs.js";
import { CanonicalFsWriteError } from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "..", "src");

const FS_WRITE_WHITELIST = new Set<string>([
  path.join(SRC_DIR, "lib", "managed-fs.ts"),
  path.join(SRC_DIR, "lib", "logger.ts"),
  // Story 5.25: lifecycle-log.ts is the designated fs write layer for the
  // always-on MCP lifecycle log file (append-only JSON-line stream).
  // It uses fs.createWriteStream for efficiency and is intentionally kept
  // separate from managed-fs.ts (which handles canonical state writes).
  path.join(SRC_DIR, "lib", "lifecycle-log.ts"),
  // Story 5.10: the persistence test exercises raw fs.writeFile to simulate what
  // SKILL.md step 4.5 does via Claude Code's built-in Write tool. This is a test
  // file, not production code — the write originates outside mcp-server/src/ in
  // the prose layer. Whitelisted so the static guard does not flag it.
  path.join(SRC_DIR, "__tests__", "dev-transcript-persistence.test.ts"),
  // Story 4.10: compute-agreement tests write JSONL fixtures directly to tmpdir
  // via raw fs.writeFile (per the spec's AC4 testing standards: "tests write JSONL
  // directly via fs.writeFile — no logTelemetryEvent"). This is a test file only;
  // the production tool is a read-only consumer.
  path.join(SRC_DIR, "tools", "__tests__", "compute-agreement.test.ts"),
  // Story 4.10b: run-auto-merge-gate tests write JSONL fixture files and done
  // manifest YAML directly to tmpdir. This is a test file only; the production
  // tool is a gate decision + gh shell-out (no raw fs writes in production code).
  path.join(SRC_DIR, "tools", "__tests__", "run-auto-merge-gate.test.ts"),
  // Story 5.11: orphan-recovery test files write manifest fixtures and transcript files
  // directly to tmpdir. These are test files only; the production tools route writes
  // through atomicWriteFile / writeManifest / moveBetweenStates (existing sanctioned seams).
  path.join(SRC_DIR, "tools", "__tests__", "scan-orphaned-in-progress.test.ts"),
  path.join(SRC_DIR, "tools", "__tests__", "reattach-orphan.test.ts"),
  path.join(SRC_DIR, "tools", "__tests__", "block-orphan-no-transcript.test.ts"),
  path.join(SRC_DIR, "__tests__", "orphan-recovery.test.ts"),
  // Story 5.20: reviewer-only respawn tests write manifest fixtures to tmpdir.
  // Test file only; production code routes all writes through sanctioned seams.
  path.join(SRC_DIR, "tools", "__tests__", "orphan-recovery-reviewer-only.test.ts"),
  // Story 5.25: the AC6b unwritable-log-path test needs a blocker file under
  // tmpDir so that mkdirSync throws ENOTDIR synchronously on every Unix-like
  // platform (replaces the unreliable /proc/nonexistent/log Linux path that
  // hung CI for 57min). Test file only; production lifecycle log writes route
  // through src/lib/lifecycle-log.ts (already whitelisted).
  path.join(SRC_DIR, "__tests__", "mcp-lifecycle-log.test.ts"),
  // Story 5.25: the lifecycle-log unit-test's "(b) survives unwritable path"
  // case uses the same blocker-file pattern for the same cross-platform
  // reliability reason. Test file only; whitelisted to match the integration
  // test's allowance.
  path.join(SRC_DIR, "lib", "__tests__", "lifecycle-log.test.ts"),
  // Story 5.27: reviewer-vitest-cwd tests seed filesystem fixture trees
  // (workspace-shape, no-manifest, root-manifest) using sync fs writes.
  // Test file only; no production writes — findPackageRoot is read-only.
  path.join(SRC_DIR, "tools", "__tests__", "reviewer-vitest-cwd.test.ts"),
  // Story 5.32: index.ts now writes the daemon's PID file to ~/.crew/mcp-daemon.pid
  // so the proxy shim (mcp-proxy) can detect the running daemon (Q4 hybrid pattern).
  // This is the transport-layer coordination file, NOT a canonical state write —
  // it lives outside any target-repo .crew/state/** path. Whitelisted because the
  // alternative (routing through managed-fs) would couple boot-time infrastructure
  // to the per-repo write policy, which is a category error.
  path.join(SRC_DIR, "index.ts"),
  // Story 5.32: proxy-spawn.test.ts is a unit test that constructs an FsPort
  // (injected) by passing real node:fs callables through to the acquire-daemon
  // factory's mocked-out write path. Test file only; no production writes.
  path.join(SRC_DIR, "__tests__", "proxy-spawn.test.ts"),
  // Story 6.2: retro-skill tests seed a fixture cycle (done/ manifest YAML,
  // telemetry JSONL, prior-proposal markdown, discipline-rules.yaml) directly
  // to tmpdir via raw fs.writeFile/mkdir. Test file only; gatherRetroInputs is
  // a read-only consumer with no production writes.
  path.join(SRC_DIR, "tools", "__tests__", "retro-skill.test.ts"),
  // Story 6.4: accept-proposal tests inject a FAKE apply handler whose `apply`
  // writes one known file to tmpdir via raw fs.writeFile (simulating what a real
  // per-kind handler does in a later story). Test file only; the production gate
  // routes the proposal-file stamp through writeManagedFile and the commit
  // through the git wrapper — it performs no raw fs writes itself.
  path.join(SRC_DIR, "tools", "__tests__", "accept-proposal.test.ts"),
  // Story 6.5: apply-rule-proposal tests seed a discipline-rules.yaml registry
  // fixture directly to tmpdir via raw fs.writeFile so the handler can be driven
  // against a pre-existing registry (and assert comment survival). Test file
  // only; the real rule apply handler routes its single registry write through
  // writeManagedFile (with the MCP tool context) and makes no commit of its own.
  path.join(SRC_DIR, "tools", "__tests__", "apply-rule-proposal.test.ts"),
  // Story 6.7: apply-skill-proposal tests seed skill files + history fixtures
  // directly to tmpdir via raw fs.writeFile/mkdir (and assert _archived/ moves).
  // Test file only; the production skill handlers route every write through
  // writeManagedFile and remove the live file via fs.rm (not a write binding).
  path.join(SRC_DIR, "tools", "__tests__", "apply-skill-proposal.test.ts"),
  // Story 6.5b: regenerate-standards tests seed registry and standards doc
  // fixtures (discipline-rules.yaml, docs/standards.md) directly to tmpdir
  // via raw fs.writeFile/mkdir so the handler + gate can be driven against
  // pre-existing state. Test file only; the production regeneration writes
  // standards.md exclusively through writeManagedFile (with MCP tool context).
  path.join(SRC_DIR, "tools", "__tests__", "regenerate-standards.test.ts"),
]);

const BANNED_WRITE_BINDINGS = [
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "createWriteStream",
];

const FS_MODULE_NAMES = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
]);

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walkTs(full, out);
    } else if (s.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("writeManagedFile runtime guard (AC5c runtime)", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop()!;
      try {
        await fs.rm(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("rejects canonical-state writes without an MCP tool context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-fs-canonical-"));
    tmpDirs.push(root);
    const target = path.join(root, ".crew", "state", "to-do", "bmad:1.yaml");

    await expect(
      writeManagedFile({
        absPath: target,
        contents: "x",
        targetRepoRoot: root,
      }),
    ).rejects.toBeInstanceOf(CanonicalFsWriteError);

    try {
      await writeManagedFile({
        absPath: target,
        contents: "x",
        targetRepoRoot: root,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalFsWriteError);
      const e = err as CanonicalFsWriteError;
      expect(e.message).toContain(target);
      expect(e.message).toContain(".crew/state/**");
      expect(e.message).toContain("(FR81/NFR16)");
    }
  });

  it("permits non-canonical writes without an MCP tool context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-fs-nocanon-"));
    tmpDirs.push(root);
    const target = path.join(root, "scratch.txt");

    await writeManagedFile({
      absPath: target,
      contents: "scratch-contents",
      targetRepoRoot: root,
    });

    const contents = await fs.readFile(target, "utf8");
    expect(contents).toBe("scratch-contents");
  });

  it("permits canonical writes when an MCP tool context is provided", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-fs-mcpctx-"));
    tmpDirs.push(root);
    const target = path.join(root, ".crew", "state", "to-do", "bmad:2.yaml");

    await writeManagedFile({
      absPath: target,
      contents: "canonical-ok",
      targetRepoRoot: root,
      mcpToolContext: { toolName: "claimStory", role: "generalist-dev" },
    });

    const contents = await fs.readFile(target, "utf8");
    expect(contents).toBe("canonical-ok");
  });
});

describe("static fs-write guard (AC5c static)", () => {
  const allSources = walkTs(SRC_DIR);

  it("no file under mcp-server/src/** (other than managed-fs.ts) imports a write-shaped fs API", () => {
    const importRegex =
      /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))\s+from\s+["']([^"']+)["']/g;
    const offences: string[] = [];

    for (const file of allSources) {
      if (FS_WRITE_WHITELIST.has(file)) continue;
      const body = readFileSync(file, "utf8");

      let match: RegExpExecArray | null;
      importRegex.lastIndex = 0;
      while ((match = importRegex.exec(body)) !== null) {
        const namedClause = match[1];
        const namespaceClause = match[2];
        const moduleName = match[4]!;
        if (!FS_MODULE_NAMES.has(moduleName)) continue;

        if (namedClause) {
          // Parse named bindings like `promises as fs, readFile, writeFile`.
          const names = namedClause
            .split(",")
            .map((n) => n.trim())
            .map((n) => {
              const renamed = n.split(/\s+as\s+/);
              return (renamed[0] ?? "").trim();
            })
            .filter((n) => n.length > 0);

          for (const name of names) {
            if (BANNED_WRITE_BINDINGS.includes(name)) {
              offences.push(`${file}: imports banned binding '${name}' from '${moduleName}'`);
            }
          }
        }

        if (namespaceClause) {
          // `import * as fs from "node:fs"` — check the body for `fs.writeFile` etc.
          const aliasMatch = namespaceClause.match(/\*\s+as\s+(\w+)/);
          const alias = aliasMatch?.[1];
          if (alias) {
            for (const banned of BANNED_WRITE_BINDINGS) {
              const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
              if (re.test(body)) {
                offences.push(
                  `${file}: uses banned API '${alias}.${banned}' via namespace import of '${moduleName}'`,
                );
              }
            }
          }
        }
      }

      // Also catch `import { promises as fs } from "node:fs"` followed by
      // `fs.writeFile(...)` etc. The named-clause parsing above only flags
      // the literal `writeFile` binding; for `promises as fs` we need to
      // scan body for `fs.writeFile`.
      const promisesAliasRegex =
        /import\s+\{\s*promises\s+as\s+(\w+)\s*\}\s+from\s+["'](?:node:)?fs["']/g;
      let aliasMatch: RegExpExecArray | null;
      while ((aliasMatch = promisesAliasRegex.exec(body)) !== null) {
        const alias = aliasMatch[1]!;
        for (const banned of BANNED_WRITE_BINDINGS) {
          const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
          if (re.test(body)) {
            offences.push(
              `${file}: uses banned API '${alias}.${banned}' via 'promises as ${alias}' import`,
            );
          }
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});

describe("static direct-gh-spawn guard (AC5b static)", () => {
  const GH_WRAPPER = path.join(SRC_DIR, "lib", "gh.ts");
  const allSources = walkTs(SRC_DIR);

  it("no file under mcp-server/src/** (other than lib/gh.ts) spawns `gh` directly", () => {
    const patterns: RegExp[] = [
      /execa\s*\(\s*["']gh["']/,
      /spawn\s*\(\s*["']gh["']/,
      /spawnSync\s*\(\s*["']gh["']/,
      /exec\s*\(\s*["']gh\s/,
    ];

    const offences: string[] = [];
    for (const file of allSources) {
      if (file === GH_WRAPPER) continue;
      const body = readFileSync(file, "utf8");
      for (const re of patterns) {
        if (re.test(body)) {
          offences.push(`${file}: direct gh spawn matched ${re}`);
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});

describe("static direct-rename guard (Story 1.6 AC6g)", () => {
  const RENAME_WRAPPER = path.join(SRC_DIR, "state", "manifest-state-machine.ts");
  // managed-fs.ts is the designated fs-write layer and is also permitted to
  // use fs.rename for atomic writes (atomicWriteFile — Task 4.5 / Story 3.4).
  const MANAGED_FS = path.join(SRC_DIR, "lib", "managed-fs.ts");
  const allSources = walkTs(SRC_DIR);

  const BANNED_RENAME_BINDINGS = ["rename", "renameSync"];

  it("no file under mcp-server/src/** (other than state/manifest-state-machine.ts and lib/managed-fs.ts) imports or invokes rename against a state-machine path", () => {
    const importRegex =
      /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))\s+from\s+["']([^"']+)["']/g;
    const offences: string[] = [];

    for (const file of allSources) {
      if (file === RENAME_WRAPPER) continue;
      if (file === MANAGED_FS) continue;
      const body = readFileSync(file, "utf8");

      let match: RegExpExecArray | null;
      importRegex.lastIndex = 0;
      while ((match = importRegex.exec(body)) !== null) {
        const namedClause = match[1];
        const namespaceClause = match[2];
        const moduleName = match[4]!;
        if (!FS_MODULE_NAMES.has(moduleName)) continue;

        if (namedClause) {
          const names = namedClause
            .split(",")
            .map((n) => n.trim())
            .map((n) => {
              const renamed = n.split(/\s+as\s+/);
              return (renamed[0] ?? "").trim();
            })
            .filter((n) => n.length > 0);

          for (const name of names) {
            if (BANNED_RENAME_BINDINGS.includes(name)) {
              offences.push(
                `${file}: imports banned rename binding '${name}' from '${moduleName}'`,
              );
            }
          }
        }

        if (namespaceClause) {
          const aliasMatch = namespaceClause.match(/\*\s+as\s+(\w+)/);
          const alias = aliasMatch?.[1];
          if (alias) {
            for (const banned of BANNED_RENAME_BINDINGS) {
              const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
              if (re.test(body)) {
                offences.push(
                  `${file}: uses banned API '${alias}.${banned}' via namespace import of '${moduleName}'`,
                );
              }
              const promisesRe = new RegExp(`\\b${alias}\\.promises\\.${banned}\\b`);
              if (promisesRe.test(body)) {
                offences.push(
                  `${file}: uses banned API '${alias}.promises.${banned}' via namespace import of '${moduleName}'`,
                );
              }
            }
          }
        }
      }

      const promisesAliasRegex =
        /import\s+\{\s*promises\s+as\s+(\w+)\s*\}\s+from\s+["'](?:node:)?fs["']/g;
      let aliasMatch: RegExpExecArray | null;
      while ((aliasMatch = promisesAliasRegex.exec(body)) !== null) {
        const alias = aliasMatch[1]!;
        for (const banned of BANNED_RENAME_BINDINGS) {
          const re = new RegExp(`\\b${alias}\\.${banned}\\b`);
          if (re.test(body)) {
            offences.push(
              `${file}: uses banned API '${alias}.${banned}' via 'promises as ${alias}' import`,
            );
          }
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});

describe("static direct-git-spawn guard (Story 1.5 AC6f)", () => {
  const GIT_WRAPPER = path.join(SRC_DIR, "lib", "git.ts");
  const allSources = walkTs(SRC_DIR);

  it("no file under mcp-server/src/** (other than lib/git.ts) spawns `git` directly", () => {
    const patterns: RegExp[] = [
      /execa\s*\(\s*["']git["']/,
      /spawn\s*\(\s*["']git["']/,
      /spawnSync\s*\(\s*["']git["']/,
      /exec\s*\(\s*["']git\s/,
    ];

    const offences: string[] = [];
    for (const file of allSources) {
      if (file === GIT_WRAPPER) continue;
      const body = readFileSync(file, "utf8");
      for (const re of patterns) {
        if (re.test(body)) {
          offences.push(`${file}: direct git spawn matched ${re}`);
        }
      }
    }

    expect(offences, offences.join("\n")).toEqual([]);
  });
});
