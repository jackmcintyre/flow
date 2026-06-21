# Story 5.27: `runVitestCheck` workspace-aware cwd resolution

story_shape: substrate
Status: review

<!-- Authored 2026-05-28 after bmad:5.24 re-roll exposed the gap. Sourced from carry-forward entry 14. -->

## Story

As a **plugin operator**,
I want **the reviewer's vitest invocation to run from the package directory that owns the test file (not the workspace root)**,
So that **vitest checks succeed in monorepo / pnpm-workspace target repos that have no root `package.json`**.

### What this story is, in one sentence

`runReviewerSession.runVitestCheck` currently invokes `pnpm vitest --run -t '<filter>'` with `cwd: targetRepoRoot` (or — post Story 5.26 — `cwd: checkRoot`). The crew repo is a pnpm workspace with **no root `package.json`**; the vitest-owning package lives at `plugins/crew/mcp-server/`. Invocation fails with `ERR_PNPM_NO_PKG_MANIFEST`; test never executes; status:fail; verdict:NEEDS CHANGES. This story makes `runVitestCheck` walk up from the test file's resolved absolute path to find the nearest enclosing `package.json` and use that directory as `cwd`.

### Why this matters now

Same lineage as Story 5.26: the marker classifier (carry-forward entry 7) was hiding both the artifact-fs gap (5.26) and this vitest-cwd gap (this story). 2026-05-28's spec-authoring-discipline fix exposed both on bmad:5.24's reviewer cycle. Without this story, every Epic 6+ story whose ACs include a `vitest:` marker will fail at the vitest invocation — even if Story 5.26 is in place — because the workspace-aware cwd resolution is a separate concern from where the filesystem check happens.

### Relationship to Story 5.26

5.26 changes `runVitestCheck`'s second positional parameter from `targetRepoRoot` to `checkRoot` (the PR-branch worktree path). 5.27 takes that `checkRoot` and walks DOWN/UP from the test file inside it to find the package root. The two stories are orthogonal: 5.26 picks the right filesystem; 5.27 picks the right invocation cwd within that filesystem.

**Per AC4 in epic-5's stub:** if 5.26 hasn't shipped yet, 5.27 still works — the walk happens against `targetRepoRoot` (the orchestrator's local dev). Both pre-5.26 and post-5.26 paths must be exercised by AC3.

---

## Acceptance Criteria

**AC1:**

`runVitestCheck` resolves its invocation `cwd` by walking up from the test file's resolved absolute path until it finds the nearest `package.json` (inclusive of the test file's directory). The walk starts at `path.dirname(path.resolve(checkRoot, testFilePath))` where `testFilePath` is derived from the `vitest:` marker, and stops at the first directory containing a `package.json`. The found directory is used as `cwd` for the `pnpm vitest --run -t '<filter>'` invocation. `checkRoot` (the bound of the walk) is the PR-branch worktree from Story 5.26 if available, otherwise `targetRepoRoot`.
artifact: plugins/crew/mcp-server/src/tools/run-reviewer-session.ts

**AC2:**

If the walk reaches `checkRoot` (inclusive) without finding any `package.json`, `runVitestCheck` returns `status: "fail"` with the reason `"no package.json found between test file '<testFilePath>' and checkRoot '<checkRoot>' — vitest cannot run without a manifest"`. It does NOT fall back to `checkRoot` as the cwd; failing-loud is correct (matches the deterministic-seam principle — silent fallback to the wrong cwd was the original bug).
artifact: plugins/crew/mcp-server/src/tools/run-reviewer-session.ts

**AC3 (integration):**

A vitest at `plugins/crew/mcp-server/src/tools/__tests__/reviewer-vitest-cwd.test.ts` seeds three fixture trees and runs `runVitestCheck` against each:
- **Fixture A (workspace shape):** outer dir with no `package.json` + inner `plugins/crew/mcp-server/` with a valid `package.json` + a passing vitest test at `plugins/crew/mcp-server/tests/my-test.test.ts`. Asserts (a) `runVitestCheck` identifies `plugins/crew/mcp-server` as cwd, (b) runs vitest there, (c) returns `status: "pass"`.
- **Fixture B (no manifest):** outer dir with no `package.json` + inner test file at `tests/orphan.test.ts` (no `package.json` anywhere above it). Asserts `status: "fail"` with the AC2 missing-manifest reason.
- **Fixture C (root-level manifest):** outer dir with a root `package.json` + test file at `tests/root.test.ts`. Asserts `cwd` resolves to the outer dir + runs successfully.
vitest: plugins/crew/mcp-server/src/tools/__tests__/reviewer-vitest-cwd.test.ts

**AC4:**

Compatibility test confirms BOTH paths work under 5.27:
- **Path 1 (pre-5.26 — no PR-branch worktree):** `runVitestCheck` is called with `checkRoot === targetRepoRoot` (orchestrator's local dev). Walk happens there. Asserted by fixture A in AC3 with `checkRoot === fixtureRoot`.
- **Path 2 (post-5.26 — PR-branch worktree present):** `runVitestCheck` is called with `checkRoot === worktreePath`. Walk happens inside the worktree. Asserted by a separate fixture that mimics a PR-branch worktree directory layout (or by stub-mocking the `materialisePrBranchWorktree` return in an integration test).
Both must return identical behaviour given identical filesystem state — the walk is `checkRoot`-rooted regardless of which one is supplied.
vitest: plugins/crew/mcp-server/src/tools/__tests__/reviewer-vitest-cwd.test.ts

**AC5:**

`runVitestCheck` accepts `testFilePath` as a NEW required parameter alongside `testNameFilter` (existing). Previously the function only knew `testNameFilter` and relied on vitest's own discovery from cwd — but to walk for the package root, we need the test file path. The caller (in the main `runReviewerSession` loop) plumbs this through from the `vitest:` marker's captured group. Update the function signature and the one call site.
artifact: plugins/crew/mcp-server/src/tools/run-reviewer-session.ts

---

## Implementation Notes

### Why this design (vs. alternatives)

Three approaches were considered:

**(a) Walk up from test file for package.json** — chosen. Simple, deterministic, no dependency on pnpm internals. Mirrors how Node module resolution finds nearest package.json. Works regardless of whether the workspace is pnpm/npm/yarn/lerna/etc. ~10 lines of code.

**(b) Use `pnpm --filter <package-name> exec vitest`** — rejected. Requires knowing the package's `name` field from the package.json (we'd still need to read it). Adds a pnpm-specific path that breaks for non-pnpm workspaces. The package.json walk subsumes this and is more portable.

**(c) Pre-compute workspace package map at session start** — rejected. Adds startup cost (scanning every package.json under targetRepoRoot), caches state that can go stale, and is overkill for a single test file resolution. The walk is O(depth-from-test-to-root) which is small.

### Files touched

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` — two changes:
  - `runVitestCheck` signature: add `testFilePath: string` parameter (the resolved absolute path of the test file). Add an internal helper `findPackageRoot({ testFilePathAbs, checkRoot })` that walks up using `path.dirname()` + `fs.access(path.join(dir, "package.json"))` until found OR until `dir === checkRoot` (inclusive). Returns `{ ok: true, packageRoot }` or `{ ok: false }`.
  - Update the main `runReviewerSession` AC-walk loop (currently line 429-456) to derive `testFilePath` from the `vitest:` marker's captured group. The current `VITEST_RE = /^vitest:\s*(.+)$/m` captures the path; `classifyAc` returns it as `testNameFilter` (confusingly named — it's the path used to construct the filter, but in practice the path IS the filter). Inspect dev to confirm whether `testNameFilter` already carries the path or if it's been transformed. If transformed, capture the raw path separately.

**NEW:**
- `plugins/crew/mcp-server/src/tools/__tests__/reviewer-vitest-cwd.test.ts` — vitest per AC3 + AC4.

### Behavioural contract

```ts
// Before (post-5.26, pre-5.27):
} else if (classification.applicability === "runnable-vitest") {
  acResults[ac.index] = await runVitestCheck(
    ac.index,
    ac.tag,
    classification.testNameFilter!,
    worktreePath,  // checkRoot from 5.26
    execaImpl,
  );
}

// runVitestCheck (before):
async function runVitestCheck(index, tag, testNameFilter, checkRoot, execaImpl) {
  const result = await execaImpl("pnpm", ["vitest", "--run", "-t", testNameFilter], {
    cwd: checkRoot,  // <-- the bug: not the package root
    reject: false,
    timeout: VITEST_TIMEOUT_MS,
  });
  // ...
}

// After (5.27):
} else if (classification.applicability === "runnable-vitest") {
  acResults[ac.index] = await runVitestCheck(
    ac.index,
    ac.tag,
    classification.testNameFilter!,
    classification.testFilePath!,  // <-- NEW: pass the path explicitly
    worktreePath,                   // checkRoot from 5.26 (or targetRepoRoot pre-5.26)
    execaImpl,
  );
}

// runVitestCheck (after):
async function runVitestCheck(
  index,
  tag,
  testNameFilter,
  testFilePath,  // NEW
  checkRoot,
  execaImpl,
) {
  const testFilePathAbs = path.resolve(checkRoot, testFilePath);
  const pkgRoot = findPackageRoot({ testFilePathAbs, checkRoot });

  if (!pkgRoot.ok) {
    return {
      index, tag,
      applicability: "runnable-vitest",
      testNameFilter,
      status: "fail",
      reason: `no package.json found between test file '${testFilePath}' and checkRoot '${checkRoot}' — vitest cannot run without a manifest`,
      stdout: "",
      stderr: "",
      exitCode: -1,
    };
  }

  const result = await execaImpl("pnpm", ["vitest", "--run", "-t", testNameFilter], {
    cwd: pkgRoot.packageRoot,  // <-- the fix: package root, not checkRoot
    reject: false,
    timeout: VITEST_TIMEOUT_MS,
  });
  // ... rest unchanged
}

// NOTE: import { accessSync } from "node:fs" at the top of run-reviewer-session.ts —
// the existing import is `import * as fs from "node:fs/promises"` which is async-only.
// `require(...)` is NOT available here: the mcp-server package is ESM
// (`"type": "module"` in package.json).
function findPackageRoot(opts: {
  testFilePathAbs: string;
  checkRoot: string;
}): { ok: true; packageRoot: string } | { ok: false } {
  const checkRootAbs = path.resolve(opts.checkRoot);
  let dir = path.dirname(opts.testFilePathAbs);

  // Bound the walk: stop when we reach checkRoot OR escape it.
  // The separator suffix on the prefix check prevents the classic
  // `"/foobar".startsWith("/foo")` false-positive (a sibling whose name
  // happens to begin with the checkRoot path).
  const isWithinCheckRoot = (d: string) =>
    d === checkRootAbs || d.startsWith(checkRootAbs + path.sep);

  while (isWithinCheckRoot(dir)) {
    try {
      accessSync(path.join(dir, "package.json"));
      return { ok: true, packageRoot: dir };
    } catch {
      // Not found here — walk up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;  // root filesystem reached
    dir = parent;
  }
  return { ok: false };
}
```

### Why `testFilePath` separately from `testNameFilter`

The current `classifyAc` extracts `testNameFilter` from the `vitest:` marker via `VITEST_RE`. The captured group is a single string. Reading the regex (`/^vitest:\s*(.+)$/m`), it captures everything after `vitest: ` to end-of-line. In practice this is a file path like `plugins/crew/mcp-server/tests/build-determinism.test.ts` — used as both the path AND the filter (vitest's `-t` flag matches against test names, not file paths, so this is actually a misuse that happens to work because vitest also discovers files from the filter when no file pattern is given).

The dev should inspect the actual `classifyAc` behaviour. Two outcomes possible:
1. `testNameFilter` IS the file path verbatim — then `testFilePath = testNameFilter` and no new field needed in `classifyAc`'s return. Pass through.
2. `testNameFilter` is something transformed — then `classifyAc` needs a new return field `testFilePath` carrying the raw match.

Either way, the public API of `runVitestCheck` gains `testFilePath` as a required parameter so the implementation is explicit about what it walks from.

### Plumbing through `classifyAc`

`classifyAc`'s return type (currently inferred):
```ts
{ applicability: "runnable-artifact-check"; artifactPath: string }
| { applicability: "runnable-vitest"; testNameFilter: string }
| { applicability: "manual-check-required" }
```

After 5.27:
```ts
{ applicability: "runnable-vitest"; testNameFilter: string; testFilePath: string }
```

If `testNameFilter === testFilePath` always (which the current regex suggests), keep both fields for clarity. Don't optimise to one — the names mean different things, and a future refactor might split them.

### Dependencies on other in-flight work

- **Soft dep on Story 5.26:** 5.27's `checkRoot` parameter is what 5.26 introduces. Pre-5.26, `checkRoot === targetRepoRoot` everywhere. Post-5.26, `checkRoot === <PR-branch worktree>`. The walk is `checkRoot`-rooted regardless, so 5.27 works in both eras. AC3's fixture A exercises the pre-5.26 path; AC3's fixture for AC4 path 2 exercises post-5.26 (mock the worktree path).
- **No blocker on 6.1/6.2/6.3:** drain stays paused until BOTH 5.26 AND 5.27 ship. See memory `project_reviewer_toolchain_gaps`.

### Build artefacts

After any change in `plugins/crew/mcp-server/src/`, run `pnpm --dir plugins/crew/mcp-server build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git". Post-5.24, the `pnpm build` chain includes the post-build normaliser — verify zero unexpected dist drift before staging.

### Edge cases worth surfacing in dev/review

- **Walk escapes `checkRoot`.** The `isWithinCheckRoot` guard in `findPackageRoot` (equality OR `startsWith(checkRootAbs + path.sep)`) ensures we never walk above `checkRoot` AND never falsely admit a sibling whose path string happens to begin with the `checkRoot` prefix (e.g. `checkRoot=/tmp/check`, sibling `/tmp/checker`). This protects against a test file with a misleading path that resolves to outside the worktree (shouldn't happen if 5.26's worktree materialisation is correct, but defence in depth).
- **Symlinks in the walk.** `path.dirname` doesn't resolve symlinks. If a test file lives under a symlinked directory inside `checkRoot`, the walk may produce unexpected paths. Use `fs.realpathSync` on `testFilePathAbs` before starting the walk to canonicalise. Confirm in dev whether this matters for the crew repo's actual layout.
- **Multiple `package.json` in the walk.** The first one found (closest to the test file) wins. That's the right semantic — the closest package owns the test. If a higher-level workspace `package.json` should override for some reason, the spec author should put the test elsewhere.
- **`pnpm-workspace.yaml` at root with no root `package.json`.** This is the crew repo's actual shape. The walk skips `pnpm-workspace.yaml` (we're only looking for `package.json`) and continues up until either finding a `package.json` or hitting `checkRoot`. For crew, it'll find `plugins/crew/mcp-server/package.json` correctly.
- **`runVitestCheck` failure path stays compatible with `runArtifactCheck`.** Both return the same `AcResult` shape. The new failure variant for missing-manifest must conform to the existing `runnable-vitest` AcResult shape (with `stdout: ""`, `stderr: ""`, `exitCode: -1` per pattern of other timeout/setup failures in the function).
- **Test framework other than vitest.** Out of scope — `runVitestCheck` is vitest-specific by design. If a future story adds support for other runners, the walk pattern from this story is reusable.

### Architectural fit / references

- **Source code** — `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`, specifically `runVitestCheck` (lines 226-279 as of 2026-05-28 and `classifyAc` (line 158-177). The `VITEST_RE` constant (line 156) is the marker regex.
- **Story 5.26** — `_bmad-output/implementation-artifacts/5-26-reviewer-session-artifact-check-against-pr-branch.md`. Soft dep — provides the `checkRoot` plumbing.
- **Deterministic seam principle** — memory `feedback_default_to_deterministic_seams`. AC2's fail-loud-on-missing-manifest is exactly this pattern: refuse to silently degrade. Originally `runVitestCheck` silently failed at the pnpm level; AC2 makes the failure explicit and located at our boundary.
- **Carry-forward source** — `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entry 14. Authoritative description.
- **Memory `project_reviewer_toolchain_gaps`** — captures the meta-pause.

---

## Definition of Done

- [x] All five ACs met (AC1–AC5).
- [x] `pnpm --dir plugins/crew/mcp-server test` green; new vitest at `reviewer-vitest-cwd.test.ts` exercises every AC3 fixture + AC4 paths.
- [x] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean — this PR's own reviewer pass should now use the fixed path (recursive validation). If the reviewer hits a vitest cwd failure on its own AC checks, that's a defect in the new code that the test suite missed.
- [x] No changes to `docs/standards.md`, `discipline-rules.yaml`, persona files, or any state directory.
- [x] `classifyAc` return type updated if `testFilePath` is added as a new field; one call site updated.
- [ ] Carry-forward entry 14 updated to "Folded into 5.27" once shipped.

---

## Dev Notes

### Implementation discoveries (2026-05-28)

**`classifyAc` inspection result:** `testNameFilter` IS the file path verbatim (outcome 1 from the spec). The `VITEST_RE` captures the full value after `vitest: `. Both `testNameFilter` and `testFilePath` are set to the same trimmed string. Both fields kept in the return type per spec guidance ("keep both for clarity").

**`findPackageRoot` export:** Exported as a named export so the `reviewer-vitest-cwd.test.ts` unit tests can exercise the walk directly without going through `runReviewerSession`.

**`runVitestCheck` cwd change:** `cwd: checkRoot` → `cwd: pkgRoot.packageRoot`. The failing-loud path (AC2) returns `{ status: "fail", exitCode: -1 }` without spawning pnpm at all. This is the correct behaviour — we never fall back to `checkRoot`.

**Existing test fixture update:** `run-reviewer-session.test.ts`'s `buildFixture` function now writes a `package.json` at `tmpRoot` so that `findPackageRoot` can resolve cwd for the `vitest: fixture passing test` AC. The walk starts at `path.dirname(path.resolve(tmpRoot, "fixture passing test"))` = `tmpRoot`; the root-level `package.json` is found there.

**canonical-fs-guard whitelist:** `reviewer-vitest-cwd.test.ts` uses sync `writeFileSync`/`mkdirSync` for fixture tree seeding (test-file only, no production writes). Added to the whitelist in `tests/canonical-fs-guard.test.ts`.
