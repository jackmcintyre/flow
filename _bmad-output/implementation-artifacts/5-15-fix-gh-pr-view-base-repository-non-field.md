# Story 5.15: Fix `gh pr view --json baseRepository` non-field in 3 reviewer/auto-merge tools

story_shape: substrate

Status: ready-for-dev

<!-- Substrate story (internal MCP-server wiring; operators don't observe `baseRepository` calls directly). Budget = 3 review passes. No "Behavioural contract" section required. -->

## Story

As a **plugin operator**,
I want **`/crew:start`'s reviewer and auto-merge tools to query a valid `gh` field for the base-repo `{owner, name}`**,
so that **the reviewer step doesn't halt every story with `Unknown JSON field: "baseRepository"`** and dogfood canaries can advance past the reviewer step.

### What this story is, in one sentence

Three MCP tools (`post-reviewer-comments`, `apply-reviewer-labels`, `run-auto-merge-gate`) currently call `gh pr view <n> --json baseRepository` — a non-existent JSON field — and tests pass only because a synthetic mock fakes the shape. This story replaces all three call sites with a real source (`gh repo view --json owner,name`), updates the mocks to match real `gh` output, and lands a grep guard so the dead field can't regress.

### Why this is L1 / dogfood-blocking

Diagnosed in `/tmp/handoff-2026-05-27-canary-baseRepository-fix.md` during the first canary against `jackmcintyre/scratch` (PR #1). Every `/crew:start` run halts the inner cycle at the reviewer step's owner/repo lookup. Until this lands, the canary cannot exit; the dogfood-pause-lifted-2026-05-27 state assumes this fix is in flight.

### What this story does NOT

- (a) Change the gh wrapper at `src/lib/gh.ts`. It already supports any kebab-cased subcommand (`repo-view` → `gh repo view`); the wrapper is unchanged.
- (b) Re-architect owner/repo discovery. The replacement source is a one-call `gh repo view --json owner,name` at each existing call site; no caching, no shared helper extracted (premature for three call sites with identical 3-line bodies).
- (c) Touch `GhApiResponseShapeError`'s message text or the `gh-error-map.yaml`. The error class is reused as-is on JSON-shape failures; the `subcommand` argument changes from `"pr-view"` to `"repo-view"`.
- (d) Add new `gh_allow` entries beyond `repo-view`. The two roles that need it (`generalist-reviewer`, `orchestrator`) get exactly that one new entry.
- (e) Add an automated AC5 canary. AC5 is a documented manual post-merge verification step, not a CI gate.

---

## Acceptance Criteria

<!--
User-surface tagging: confirmed NONE. AC5's `/crew:start` invocation is a post-merge manual canary observation, not code-driven by this story. All ACs are substrate.
-->

**AC1:**
**Given** the three call sites at `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts:223-246`, `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts:103-126`, and `plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts:329-352`,
**When** the change lands,
**Then** none of the three files contain the literal string `baseRepository` anywhere, and each call site invokes the gh wrapper with `subcommand: "repo-view"`, `args: ["--json", "owner,name"]` (no PR-number argument — `gh repo view` resolves the current repo from the cwd), parses the returned JSON as `{ name: string; owner: { login: string } }`, and assigns `owner = json.owner.login`, `repo = json.name`. On a missing or empty `owner.login` or `name`, the existing `GhApiResponseShapeError` is thrown with `subcommand: "repo-view"`. The downstream `reviewsApiUrl` / `labelsUrl` strings remain unchanged in structure. `artifact: plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts, plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts, plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts`

<!--
Replacement-source decision (epic AC1 left this to the spec author):

PICKED: `gh repo view --json owner,name`.

Rationale:
- Same tool family as existing code; the existing `gh` wrapper at `src/lib/gh.ts` already kebab-splits subcommands, so `subcommand: "repo-view"` requires no wrapper change.
- Returns structured JSON; no remote-URL regex parsing required.
- Works regardless of HTTPS-vs-SSH remote URL form, regardless of whether the operator has a `git` config in scope.
- Stays inside the existing role-permissions / negative-flag / error-map machinery (one new `gh_allow` entry per role; see AC1 sub-task below).
- Real-host shape confirmed on this machine: `gh repo view --json owner,name` → `{"name":"crew","owner":{"id":"...","login":"jackmcintyre"}}`. The extra `owner.id` field is harmless; we read only `owner.login` and `name`.

Rejected: `git config --get remote.origin.url` + regex. Adds a new shell-out tool family (`git`) at sites that today only invoke `gh`; requires URL parsing (HTTPS vs SSH vs SSH+user); doesn't benefit from the gh-error-map classification or role permissions.
-->

**AC1 sub-task — role-permission allowlist:** The two roles that exercise the changed code paths (`generalist-reviewer` invokes `post-reviewer-comments`, `apply-reviewer-labels`, and `run-auto-merge-gate`; `orchestrator` invokes `run-auto-merge-gate` from the auto-merge gate step) get `repo-view` added to their `gh_allow:` list. Files: `plugins/crew/permissions/generalist-reviewer.yaml`, `plugins/crew/permissions/orchestrator.yaml`. No other role's permissions change. `artifact: plugins/crew/permissions/generalist-reviewer.yaml, plugins/crew/permissions/orchestrator.yaml`

**AC2 (integration test):**
**Given** a host with `gh` installed and authenticated against any repo,
**When** the integration test at `plugins/crew/mcp-server/src/tools/__tests__/gh-base-repo.integration.test.ts` runs,
**Then** the test shells out to a real `gh repo view --json owner,name` using `child_process.execSync` (no mocks, no `execaImpl` injection — this is the explicit point of the test: to validate the real schema), JSON-parses the stdout, asserts the returned shape matches `{ name: string; owner: { login: string } }` (shape only — no repo-identity assertion such as `owner.login === "jackmcintyre"`), and asserts both `name` and `owner.login` are non-empty strings. The test is wrapped in `it.skipIf(<probe>)` where `<probe>` evaluates to `true` (skip) when (a) `gh` is not on `PATH` OR (b) `gh auth status` exits non-zero. The probe itself runs `execSync("gh auth status", { stdio: "pipe" })` inside a try/catch — the catch returns `true`, the success path returns `false`. The probe is invoked exactly once per file at module load (computed into a `const`), so the skip decision is deterministic and side-effect-free per run. `vitest: plugins/crew/mcp-server/src/tools/__tests__/gh-base-repo.integration.test.ts`

<!--
Note on test-helpers: the project has a `gh-execa-stub` helper at `src/__tests__/test-helpers/gh-execa-stub.ts`, but it is a STUB factory for unit-mode tests. There is no existing real-gh shell-out helper. AC2 is a deliberately thin integration test that exercises the real binary; `child_process.execSync` keeps it dependency-free (no execa import) and matches the standard Node API for one-shot subprocess calls in tests. Vitest is at ^2.1.0; `it.skipIf` ships in 2.x.

Sample asserted shape (confirmed against gh 2.92.0 on this host):
{
  "name": "crew",
  "owner": { "id": "MDQ6VXNlcjM3NDEwNg==", "login": "jackmcintyre" }
}
We assert ONLY: typeof name === "string", name.length > 0, typeof owner.login === "string", owner.login.length > 0. The `id` field is unread.
-->

**AC3 (grep-guard test):**
**Given** the source tree under `plugins/crew/mcp-server/src/`,
**When** the guard test at `plugins/crew/mcp-server/src/tools/__tests__/no-base-repository-field.test.ts` runs,
**Then** the test recursively walks `plugins/crew/mcp-server/src/` using Node's `fs/promises.readdir({ withFileTypes: true, recursive: true })` (or a tight handwritten async recursive walker if `recursive: true` proves flaky on older Node) collecting only `*.ts` files, **excludes its own directory** `plugins/crew/mcp-server/src/tools/__tests__/` and excludes `plugins/crew/mcp-server/src/__tests__/test-helpers/` (the test-helper stub directory) so neither the assertion text nor the legacy stub default-string trips the guard, and for each remaining file scans line-by-line. Any line that contains BOTH the substring `gh pr view` AND the substring `baseRepository` is collected; if the collection is non-empty, the test fails with an assertion message listing each `<absolute-or-repo-relative path>:<line-number>` offender on its own line. Empty collection → test passes. The walk MUST complete in well under a second on the current tree (synchronous `readFile` calls are acceptable; no globbing dep required). `vitest: plugins/crew/mcp-server/src/tools/__tests__/no-base-repository-field.test.ts`

<!--
Excluded directories (rationale):
- `plugins/crew/mcp-server/src/tools/__tests__/` — the assertion-message text in THIS guard test itself contains both substrings.
- `plugins/crew/mcp-server/src/__tests__/test-helpers/` — `gh-execa-stub.ts` mentions `baseRepository` in the JSDoc comment and `DEFAULT_PR_VIEW_JSON` constant. This file is migrated under AC4 (DEFAULT constant replaced) and its JSDoc is updated, but excluding the directory entirely insulates the guard from future test-helper churn.

Pattern choice: the guard intentionally requires BOTH `gh pr view` AND `baseRepository` on the SAME line. This is conservative (won't catch a multi-line refactor that splits the field name onto its own line), but matches how the original defect is written and avoids false positives from unrelated mentions of `baseRepository` in unrelated `gh` docs strings.
-->

**AC4 (mock fixture migration):**
**Given** the existing mock at `plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts:53-55` which currently reads `const DEFAULT_PR_VIEW_JSON = JSON.stringify({ baseRepository: { name: "crew", owner: { login: "jackmcintyre" } } });`,
**When** AC1 lands,
**Then** that constant is replaced with `const DEFAULT_REPO_VIEW_JSON = JSON.stringify({ name: "crew", owner: { login: "jackmcintyre" } });` and every reference to `DEFAULT_PR_VIEW_JSON` inside `run-auto-merge-gate.test.ts` is updated to `DEFAULT_REPO_VIEW_JSON`. AND the shared stub helper at `plugins/crew/mcp-server/src/__tests__/test-helpers/gh-execa-stub.ts` is migrated in the same change: the `DEFAULT_PR_VIEW_JSON` constant (line 60) is replaced with `DEFAULT_REPO_VIEW_JSON` carrying the new shape `{ name: "crew", owner: { login: "jackmcintyre" } }`; the `prView` opt key is renamed to `repoView`; the routing branch at lines 95-103 changes from `sub0 === "pr" && sub1 === "view"` to `sub0 === "repo" && sub1 === "view"`; and the JSDoc comments at lines 5-6 and 41 are updated to reference `gh repo view --json owner,name` instead of `gh pr view --json baseRepository`. Every consumer of the stub helper in the test tree is updated in the same change (callsites for `prView:` opt → `repoView:`). `vitest: plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts, plugins/crew/mcp-server/src/__tests__/test-helpers/gh-execa-stub.ts, plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts, plugins/crew/mcp-server/src/tools/__tests__/apply-reviewer-labels.test.ts`

<!--
Stub-helper consumer audit — every test file that imports `makeGhExecaStub` or references `prView:` will need the renamed key:

The dev agent MUST grep `makeGhExecaStub\|prView:` across `plugins/crew/mcp-server/src/` and update every match. As of this writing the known consumers are:

- src/tools/__tests__/run-auto-merge-gate.test.ts (has its own local DEFAULT_PR_VIEW_JSON; also may call makeGhExecaStub)
- src/tools/__tests__/post-reviewer-comments.test.ts
- src/tools/__tests__/apply-reviewer-labels.test.ts
- src/tools/__tests__/process-reviewer-yield.test.ts (uses the stub for reviewer-flow integration)
- src/tools/__tests__/inner-cycle.integration.test.ts (full inner-cycle integration)

The grep MUST also pick up any *.test.ts file that hand-rolls a `baseRepository: { ... }` shape outside the shared stub (none currently expected — `grep -rn 'baseRepository'` confirmed the only matches are the three production files, run-auto-merge-gate.test.ts:54, gh-execa-stub.ts:61, errors.ts:1110 docstring, and the epic block itself).

`errors.ts:1110` is a JSDoc comment on `GhApiResponseShapeError` that says `"or when 'gh pr view --json baseRepository' returns an unexpected shape."`. Update it to reference `gh repo view --json owner,name`. This is non-load-bearing (comment only) but the AC3 guard would NOT trip on it (no `gh pr view` + `baseRepository` on the same line if rewritten properly; and even if it did, errors.ts lives outside `src/tools/` — recheck the guard's walk scope to confirm. Actual walk scope per AC3 is `src/` recursive, so errors.ts WOULD be in scope. The dev agent MUST update this docstring as part of AC4).
-->

**AC5 (manual canary — POST-MERGE, NOT A CI GATE):**
**Given** the orphan in-progress manifest preserved from today's canary against `jackmcintyre/scratch` (PR #1),
**When** the operator re-runs `/crew:start` from the scratch directory after this story merges,
**Then** the reviewer step advances past the owner/repo lookup without an `Unknown JSON field: "baseRepository"` halt, and the gate either auto-merges or applies `needs-human` cleanly. Documented in `_bmad-output/implementation-artifacts/epic-5-retrospective.md` (or successor retro file). No automated test for this AC.

### Manual verification (AC5)

After this story's PR merges to `dev` (and `dev` → `main` if promoting), run from a fresh Claude Code session:

```bash
SCRATCH=$(cat /tmp/crew-canary-scratch-path)
cd "$SCRATCH"
claude --plugin-dir /Users/jackmcintyre/projects/crew/plugins/crew
# Inside Claude Code:
#   /crew:start
```

**Observe:** the reviewer step proceeds past `gh repo view` without an `Unknown JSON field` error in the chat log; the auto-merge gate either merges PR #1 or labels it `needs-human` and `reviewed-by-agent`. Capture the chat tail and paste into the Epic 5 retro.

**Negative path to watch for:** if `gh repo view` itself fails (auth lapse, network), the failure should now surface through `GhRecoverableError` (mapped via `gh-error-map.yaml`) or `GhApiResponseShapeError` — NOT through `Unknown JSON field`. Either of those two is acceptable; the original symptom is not.

---

## Developer context

### Files to MODIFY (production code)

1. **`plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`** — lines 223-246 (Step 3 block).
   - Replace `subcommand: "pr-view"` with `subcommand: "repo-view"`.
   - Replace `args: [String(resultFile.prNumber), "--json", "baseRepository"]` with `args: ["--json", "owner,name"]` (drop the PR-number arg; `gh repo view` operates on the current repo).
   - Replace the JSON-parse shape from `{ baseRepository?: { name?: string; owner?: { login?: string } } }` to `{ name?: string; owner?: { login?: string } }`.
   - Assign `owner = prViewJson.owner?.login ?? "";` and `repo = prViewJson.name ?? "";` (no `.baseRepository?.` indirection).
   - Update the inline comment "Step 3: Resolve {owner} and {repo} via `gh pr view --json baseRepository`" to say `gh repo view --json owner,name`.
   - The thrown `GhApiResponseShapeError` constructor argument should change to `{ subcommand: "repo-view", cause }`.
   - Consider renaming the local `prViewResult` / `prViewJson` variables to `repoViewResult` / `repoViewJson` for clarity. Optional but recommended.

2. **`plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts`** — lines 103-126 (Step 3 block). Same shape of change as above. Note this file currently passes `String(prNumber)` to the args — drop it.

3. **`plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts`** — lines 329-352 (Step 9a block). Same shape of change. Currently passes `String(opts.prNumber)` — drop it.

4. **`plugins/crew/mcp-server/src/errors.ts`** — line ~1110: update the JSDoc on `GhApiResponseShapeError` to reference `gh repo view --json owner,name` instead of `gh pr view --json baseRepository`. (Non-load-bearing but required so the AC3 grep guard doesn't trip on it once it walks `src/`.)

### Files to MODIFY (role permissions)

5. **`plugins/crew/permissions/generalist-reviewer.yaml`** — add `repo-view` to the `gh_allow:` list. Maintain alphabetical order if the existing list is alphabetical; otherwise append.

6. **`plugins/crew/permissions/orchestrator.yaml`** — add `repo-view` to `gh_allow:` (same rule).

### Files to MODIFY (tests)

7. **`plugins/crew/mcp-server/src/__tests__/test-helpers/gh-execa-stub.ts`** — see AC4 detail above. Rename constant, rename `prView` → `repoView` opt key, change the route from `pr view` → `repo view`, update JSDoc.

8. **`plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts`** — line 53-55 local constant rename + every reference inside the file. Any `makeGhExecaStub({ prView: ... })` callsite becomes `makeGhExecaStub({ repoView: ... })`.

9. **`plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts`** — update `prView:` → `repoView:` at every callsite, and any locally hand-rolled `baseRepository: { ... }` JSON literal becomes `{ name: ..., owner: { login: ... } }`.

10. **`plugins/crew/mcp-server/src/tools/__tests__/apply-reviewer-labels.test.ts`** — same.

11. **Any other test that imports `makeGhExecaStub`** — confirm via `grep -rn 'makeGhExecaStub\|prView:' plugins/crew/mcp-server/src/` and migrate. Known suspects: `process-reviewer-yield.test.ts`, `inner-cycle.integration.test.ts`.

### Files to CREATE (tests)

12. **`plugins/crew/mcp-server/src/tools/__tests__/gh-base-repo.integration.test.ts`** — per AC2. Skeleton:

```ts
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

// Probe once at module load. Skip-if returns true when gh is unavailable or unauthed.
const SKIP_REASON: string | null = (() => {
  try {
    execSync("gh auth status", { stdio: "pipe" });
    return null;
  } catch {
    return "gh not on PATH or not authenticated";
  }
})();

describe("gh repo view --json owner,name (real-host integration)", () => {
  it.skipIf(SKIP_REASON !== null)(
    "returns { name: string; owner: { login: string } } shape",
    () => {
      const stdout = execSync("gh repo view --json owner,name", {
        encoding: "utf-8",
      });
      const parsed = JSON.parse(stdout) as {
        name?: unknown;
        owner?: { login?: unknown };
      };
      expect(typeof parsed.name).toBe("string");
      expect((parsed.name as string).length).toBeGreaterThan(0);
      expect(typeof parsed.owner?.login).toBe("string");
      expect((parsed.owner!.login as string).length).toBeGreaterThan(0);
    },
  );
});
```

13. **`plugins/crew/mcp-server/src/tools/__tests__/no-base-repository-field.test.ts`** — per AC3. Skeleton:

```ts
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Walk root: plugins/crew/mcp-server/src/
const SRC_ROOT = path.resolve(HERE, "..", "..", "..", "src");

// Directories excluded from the scan (see AC3 rationale).
const EXCLUDE_DIRS = new Set<string>([
  path.resolve(SRC_ROOT, "tools", "__tests__"),
  path.resolve(SRC_ROOT, "__tests__", "test-helpers"),
]);

async function walkTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(full)) continue;
      out.push(...(await walkTsFiles(full)));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("guard: no `gh pr view ... baseRepository` references remain", () => {
  it("finds zero offenders under plugins/crew/mcp-server/src/", async () => {
    const files = await walkTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf-8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        if (line.includes("gh pr view") && line.includes("baseRepository")) {
          offenders.push(`${file}:${idx + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Found ${offenders.length} offending line(s):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
```

### Files NOT to touch

- `src/lib/gh.ts` — wrapper handles `repo-view` already via kebab-split.
- `gh-error-map.yaml` — unchanged. Any `gh repo view` exit-code-1 surface still classifies via the existing map.
- `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md` — no edit needed; that postmortem is about the three earlier L1 defects, not this one.
- Any skill `.md` (start, scan, hire, etc.) — no operator-surface text changes from this story.

---

## Implementation strategy

1. **Make the three production-code changes first** (post-reviewer-comments, apply-reviewer-labels, run-auto-merge-gate) — three near-identical small diffs. Compile (`pnpm -F crew-mcp-server build`) after each to catch typos.
2. **Add `repo-view` to the two role-permissions YAMLs.** Without this, the new code paths will throw `GhSubcommandDeniedError` at runtime.
3. **Migrate the shared stub (`gh-execa-stub.ts`)** — rename constant, rename opt key, change the route condition. Run only the stub-helper unit tests at this point.
4. **Sweep the stub consumers** (`grep -rn 'makeGhExecaStub\|prView:' src/`) and update every callsite.
5. **Migrate the local mock at `run-auto-merge-gate.test.ts:53-55`.**
6. **Update the `errors.ts:1110` JSDoc string** so the AC3 guard, once added, doesn't trip on it.
7. **Add the two new test files** (`gh-base-repo.integration.test.ts`, `no-base-repository-field.test.ts`). Run them last; the guard should pass cleanly with zero offenders.
8. **Full test suite** (`pnpm -F crew-mcp-server test`) must pass. Build (`pnpm build`) must succeed. Commit `dist/` per the project rule that plugin build output is tracked in git.

### Regression risks to watch

- **Role-permissions migration is load-bearing.** If you forget `repo-view` on either YAML, every reviewer/auto-merge invocation will throw `GhSubcommandDeniedError` at runtime — and the unit tests, which use a stubbed permissions object (`tests/fixtures/permissions/test-role.yaml` or hand-rolled), will NOT catch it. The AC2 integration test exercises the real binary but bypasses the gh wrapper's permission check (it shells out directly with `execSync`). So: confirm the YAML edits via a deliberate eyeball pass.
- **Stub-helper rename has spillage.** Any test file that hand-rolls a `baseRepository:` literal outside the shared stub (the grep confirmed zero such cases today, but a stale branch could reintroduce one) will silently keep passing against unrealistic data. The AC3 guard catches the production-code shape but is intentionally narrow (BOTH `gh pr view` AND `baseRepository` on the same line). A migrated test that drops `gh pr view` but keeps `baseRepository:` would slip the guard. The dev agent should grep `baseRepository` once at the end and confirm only the gh-execa-stub default-constant and the errors.ts JSDoc remain (both updated under AC4).
- **`dist/` drift.** Per project rule (`CLAUDE.md` § Plugin build output is tracked in git), rebuild and commit `dist/` in the same change. CI fails on drift.

---

## Test plan

| AC | Test | File | Mode |
|----|------|------|------|
| AC1 | Three-file edit verified by AC3 grep guard | (no dedicated test — AC3 covers regression) | n/a |
| AC1 sub-task | Role YAML diff inspected; integration coverage via existing reviewer/auto-merge tests now exercising the new `repo-view` route through the stub | run-auto-merge-gate.test.ts, post-reviewer-comments.test.ts, apply-reviewer-labels.test.ts | unit (existing tests, migrated) |
| AC2 | Real `gh repo view --json owner,name` shape assertion, skipped when gh unavailable | gh-base-repo.integration.test.ts | integration (new) |
| AC3 | Grep guard across `src/` excluding test/test-helper dirs | no-base-repository-field.test.ts | unit (new) |
| AC4 | Stub-helper rename + every callsite migrated | gh-execa-stub.ts + every *.test.ts importing it | unit (existing tests, migrated) |
| AC5 | Manual post-merge canary (NOT a CI gate) | n/a — operator-driven | manual |

`pnpm -F crew-mcp-server test` must be green with the changes. `pnpm build` must succeed and `dist/` must be committed in the same change.

---

## Behavioural contract

(Not applicable — substrate story per `story_shape: substrate`.)

---

## Definition of done

- [ ] All three production tools call `gh repo view --json owner,name` and consume the flat `{ name, owner: { login } }` shape.
- [ ] `generalist-reviewer.yaml` and `orchestrator.yaml` have `repo-view` in `gh_allow:`.
- [ ] Shared stub helper (`gh-execa-stub.ts`) migrated; every consumer updated.
- [ ] `run-auto-merge-gate.test.ts` local mock migrated.
- [ ] `errors.ts` JSDoc updated.
- [ ] `gh-base-repo.integration.test.ts` exists and passes (or skips on hosts without gh).
- [ ] `no-base-repository-field.test.ts` exists, walks `src/` excluding the two listed directories, and finds zero offenders.
- [ ] `grep -rn 'baseRepository' plugins/crew/mcp-server/src/` returns zero results after the change (modulo any comment in `errors.ts` — that comment must also be rewritten).
- [ ] `pnpm -F crew-mcp-server test` green.
- [ ] `pnpm -F crew-mcp-server build` succeeds; `plugins/crew/mcp-server/dist/` committed in the same change.
- [ ] PR opened against `dev` branch (per project posture).
- [ ] AC5 manual canary documented in Epic 5 retro after merge.

---

## Dependencies

- None on code. This is a leaf substrate fix.
- Sequenced with: dogfood-pause-lift (2026-05-27) — AC5 canary cannot run until this lands.

> Depends on Story (none).

---

## Notes for the dev agent

- The substrate budget is **3 review passes**. The change is small (three near-identical 5-line edits + two YAML adds + a stub rename + two new tests). Aim for one-shot.
- Do not extract a shared `resolveOwnerRepo()` helper "to DRY up the three call sites." Three is below the rule-of-three threshold and the bodies are different enough (different surrounding context, different return shapes for the calling function) that the abstraction would cost more than it saves. Tracker note only — not a request.
- Do not change the gh-wrapper, error map, or `GhApiResponseShapeError` constructor signature. The only argument that changes is the string passed as `subcommand` ("pr-view" → "repo-view").
- Do not add new gh subcommands to any role beyond `repo-view` on `generalist-reviewer` and `orchestrator`.
- If a test in step 4 (stub-consumer sweep) fails for a reason that LOOKS unrelated to this story, STOP and ask before fix-forwarding. Per project rule (memory `feedback_stop_dont_fix_forward`).
