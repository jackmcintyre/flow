# Story 5.16: `scan-sources` deps-drift on source-hash refresh (to-do branch)

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **`/crew:scan` to refuse to overwrite a `to-do/` manifest when the refreshed source body's prose deps drift from the manifest's `depends_on`**,
so that **planner-author drift introduced after the first scan is caught with the same `[deps-drift]` signal as drift introduced at first scan or in `blocked/`**.

### What this story is, in one sentence

Close the third leak of the deps-drift gate: add a `checkDepsDrift` call to the to-do source-hash refresh branch of `scan-sources.ts` (currently lines 592-610), mirroring the gate already wired into the blocked-branch path (line 404) and the fresh-create path (line 496). Without this mirror, an operator who edits a spec body to introduce a new dep AFTER the manifest is in `to-do/` silently bypasses the gate Story 5.13 added.

### Why this is independent

5.13 shipped the `checkDepsDrift` helper, the `writeDepsDriftBlockedManifest` helper, the typed `blocked_by: "deps-drift"` enum member, the `depsDriftRefs` field on `ScanResult`, and the `[deps-drift]` render line. This story does NOT change any of those — it only adds a third call site for the same helper. No schema change, no new lib, no render change, no skill change.

### What this story does NOT

- (a) Change `checkDepsDrift` or `writeDepsDriftBlockedManifest` signatures or behaviour.
- (b) Add new dep-extraction patterns. The two patterns from 5.13 (`Depends on:` and `> Depends on Story X.Y`) are used as-is.
- (c) Change the `ScanResult` shape. `depsDriftRefs` and `blockedRefs` are populated the same way.
- (d) Change the rendered output format. The existing `[deps-drift] <ref> — prose: {...}, manifest: {...}` line emits identically.
- (e) Re-architect the to-do refresh branch. The new gate inserts AT THE TOP of the existing `if (existingManifest.source_hash !== story.source_hash)` block, before `writeManagedFile` runs.

---

## Acceptance Criteria

**AC1:**
**Given** an existing `to-do/` manifest whose `source_hash` no longer matches the live source story's hash (operator edited the spec body),
**When** `scanSources` enters the to-do refresh branch in `scan-sources.ts` (currently lines 592-610, inside the `if (existingManifest.source_hash !== story.source_hash)` block at line 592, BEFORE the `writeManagedFile` call at line 604),
**Then** the branch first calls `await checkDepsDrift(story)`. If `driftDetail !== null`, the branch follows the same shape as the blocked-branch path at line 404: (a) compute `absBlockedPath = path.join(stateRoot, "blocked", \`${story.ref}.yaml\`)`, (b) call `await writeDepsDriftBlockedManifest(story, driftDetail, absBlockedPath, activeAdapterName, targetRepoRoot)`, (c) push to `result.skippedRefs` with `reason: "discipline-violation"` and `detail: \`deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]\``, (d) push the ref to `result.blockedRefs`, (e) push `{ ref: story.ref, proseRefs: driftDetail.proseRefs, manifestRefs: driftDetail.manifestRefs }` to `result.depsDriftRefs`, (f) `continue` (do NOT rewrite the to-do manifest, do NOT push to `result.updatedRefs`). The refusal text and shape match the other two branches verbatim — copy-paste-tweak from lines 404-426 is the intended pattern.
`artifact: plugins/crew/mcp-server/src/tools/scan-sources.ts`

**AC2 (integration):**
**Given** the vitest harness for `scan-sources`,
**When** the suite runs the new test file `scan-sources-drift-on-refresh.test.ts`,
**Then** vitest covers three cases end-to-end against a fixture target repo with a native adapter source spec and a seeded `to-do/` manifest: **(a) drift-introduced-on-refresh** — seed a `to-do/` manifest whose `depends_on` matches the original spec; edit the spec on disk to introduce a prose `Depends on:` line whose ref the manifest omits (which also changes the spec body and therefore `source_hash`); run `scanSources`; assert (i) the `to-do/` manifest is NOT overwritten — its on-disk bytes' parsed `source_hash` and `depends_on` are identical to the pre-scan values, (ii) a `blocked/` manifest is written at `<targetRepoRoot>/.crew/state/blocked/<ref>.yaml` with `blocked_by: "deps-drift"` and a `discipline_violations[0].code` of `"deps-drift-prose-vs-manifest"`, (iii) `result.depsDriftRefs` contains an entry for the ref with the expected `proseRefs` and `manifestRefs` arrays, (iv) `result.blockedRefs` contains the ref, (v) `result.updatedRefs` does NOT contain the ref. **(b) no-drift-on-refresh (idempotency control)** — seed a `to-do/` manifest; edit the spec body in a way that changes `source_hash` but does NOT introduce a new prose dep (e.g. tweak narrative text only); run `scanSources`; assert (i) the `to-do/` manifest IS rewritten with the new `source_hash`, (ii) `result.updatedRefs` contains the ref, (iii) no `blocked/` manifest is written, (iv) `result.depsDriftRefs` is empty for this ref. **(c) drift-already-present-pre-refresh** — seed a `to-do/` manifest whose `depends_on` already matches the original spec; edit the spec to introduce a prose dep AND a manifest extra dep simultaneously (symmetric drift, both directions); run `scanSources`; assert the same `blocked/` outcome as (a) with both `proseRefs` and `manifestRefs` reflecting the symmetric difference.
`vitest: plugins/crew/mcp-server/src/tools/__tests__/scan-sources-drift-on-refresh.test.ts`

---

## Implementation Strategy

### Files touched

**MODIFY:**

- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — the to-do source-hash refresh branch inside the `currentState === "to-do"` arm (currently lines 577-615). The new drift gate inserts at the TOP of the inner `if (existingManifest.source_hash !== story.source_hash)` block at line 592, BEFORE the existing rewrite path (lines 596-610). Pattern mirrors the blocked-branch path at lines 404-426 exactly.

**NEW:**

- `plugins/crew/mcp-server/src/tools/__tests__/scan-sources-drift-on-refresh.test.ts` — three cases per AC2. Fixture pattern: scratch `targetRepoRoot` under `os.tmpdir()`, seed `.crew/state/to-do/<ref>.yaml` with a hand-crafted manifest, write a source spec under the adapter's path, run `scanSources({ targetRepoRoot })`, assert on the returned `ScanResult` and on the post-scan filesystem state.

### Where the new code lands (verbatim line refs)

The existing to-do refresh branch is at `plugins/crew/mcp-server/src/tools/scan-sources.ts` lines 577-615. The insertion point is inside the `if (existingManifest.source_hash !== story.source_hash)` block at line 592, immediately after the block opens and BEFORE the construction of `updatedManifest` at line 596. The reference pattern to mirror is the blocked-branch drift gate at lines 404-426 (post-hash-change, before the discipline-violation fallthrough).

Concrete shape of the new code (copy-paste-adapt from lines 404-426, dropping the comment about "blocked manifest" since this branch is the to-do-refresh one):

```ts
if (existingManifest.source_hash !== story.source_hash) {
  // Story 5.16: deps-drift gate on to-do refresh — mirrors blocked-branch (line 404)
  // and currentState === null (line 496). Without this, an operator edit that
  // introduces a new prose dep AFTER first scan would silently absorb into the
  // refreshed to-do manifest.
  const driftDetail = await checkDepsDrift(story);
  if (driftDetail !== null) {
    const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
    await writeDepsDriftBlockedManifest(
      story,
      driftDetail,
      absBlockedPath,
      activeAdapterName,
      targetRepoRoot,
    );
    result.skippedRefs.push({
      ref: story.ref,
      reason: "discipline-violation",
      detail: `deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]`,
    });
    result.blockedRefs.push(story.ref);
    result.depsDriftRefs.push({
      ref: story.ref,
      proseRefs: driftDetail.proseRefs,
      manifestRefs: driftDetail.manifestRefs,
    });
    continue;
  }

  // No drift — existing rewrite path (lines 596-610) follows unchanged.
  const updatedManifest = {
    ...existingManifest,
    source_hash: story.source_hash,
    source_path: repoRelativePath(story.raw_path, targetRepoRoot),
  };
  // ... existing writeManagedFile + result.updatedRefs.push ...
}
```

The `continue` inside the drift branch jumps to the next iteration of the `for (const story of sourceStories)` loop, exactly like the blocked-branch and fresh-create paths do.

### Sequencing

1. Add the drift gate to `scan-sources.ts` (single-block insertion, no other code moves).
2. Write `scan-sources-drift-on-refresh.test.ts` covering the three cases in AC2. Fixture style matches the existing scan-sources tests — see § Fixture pattern below.
3. Run `pnpm -r test` from `plugins/crew/mcp-server/`. Expect all existing tests to remain green (no semantic shift to the existing to-do refresh path when there is no drift). Expect the three new cases to pass.
4. Run `pnpm -r build` and commit the resulting `plugins/crew/mcp-server/dist/` changes in the same change set (per project CLAUDE.md § "Plugin build output is tracked in git").

### Fixture pattern (recommended)

The existing `__tests__/` directory has no dedicated `scan-sources.test.ts` — the closest patterns are the integration tests like `claim-complete-loop.integration.test.ts`, `hand-edit-allowance.integration.test.ts`, and `inner-cycle.integration.test.ts`, which all use scratch `tmpdir()` target repos with a native adapter and hand-seeded `.crew/state/<dir>/<ref>.yaml` manifests. The dev agent should:

- Use `mkdtemp(path.join(os.tmpdir(), "scan-drift-"))` to create an isolated `targetRepoRoot`.
- Seed a minimal native adapter config (`plugins/crew/state/native-adapter.yaml` or whatever the test helpers use — the dev agent reads `hand-edit-allowance.integration.test.ts` first to copy the harness).
- Write a source spec under the adapter's expected source-stories path with a known `source_hash`-relevant body.
- Seed `.crew/state/to-do/<ref>.yaml` directly via `fs.writeFile` with a `yamlStringify`-ed manifest that has the matching `depends_on` for case (a)/(b) preconditions.
- Call `scanSources({ targetRepoRoot })` directly (this is the exported function in `scan-sources.ts`).
- Assert on the returned `ScanResult` AND on the post-scan filesystem state via `fs.readFile` + `yamlParse`.

The dev agent SHOULD reuse the helper conventions already established in `hand-edit-allowance.integration.test.ts` (which exercises the same to-do refresh branch from a different angle — hand-edit preservation) and the operator-smoke fixtures under `__tests__/operator-smoke-helpers/` if any of them already construct a scan-able native repo.

### Edge cases

- **Drift introduced on refresh BUT manifest is in `blocked/` or `in-progress/`:** out of scope — those paths are owned by other branches (`currentState === "blocked"` at line 389 already has its own drift gate per Story 5.13; `in-progress` / `done` skip unconditionally per line 381). This story only fixes the `currentState === "to-do"` arm.
- **Hash unchanged AND prose drift introduced (impossible in practice):** the prose drift can only exist if the spec body changed; the body change is what computes the new hash. The existing `else { result.unchangedRefs.push(...) }` path at line 612 will run, and no drift check is needed. The dev agent does NOT add a drift check to the hash-unchanged path.
- **Drift fixed on refresh (operator was previously drifting and has now corrected the manifest by hand-edit):** the gate calls `checkDepsDrift`, gets `null`, falls through to the existing rewrite path. The to-do manifest is updated with the new hash. This is the correct symmetric behaviour — no special-casing needed.
- **`checkDepsDrift` fails to read the source file:** the helper returns `null` (per the existing `try { fs.readFile } catch { return null }` at lines 175-180). The to-do refresh proceeds normally. No false-positive block. This is the same trade-off Story 5.13 made in the other two branches.

### What MUST NOT be touched

- `checkDepsDrift` or `writeDepsDriftBlockedManifest` — both are reused as-is.
- The `ExecutionManifestSchema` `blocked_by` enum — `deps-drift` is already a member (added by 5.13).
- `renderScanResult` — the existing `[deps-drift]` line already iterates `result.depsDriftRefs`; appending a new entry from this branch surfaces in the rendered output without any render-layer change.
- The two existing drift gates at lines 404 and 496 — they continue to work unchanged.
- `/crew:scan` SKILL.md — no skill prose change. The new gate is internal to `scan-sources.ts`.

### Build artefacts (`dist/` discipline)

After the `src/` change, the dev agent MUST run `pnpm -r build` from `plugins/crew/mcp-server/` and stage `plugins/crew/mcp-server/dist/` in the same commit. CI fails on drift per project CLAUDE.md § "Plugin build output is tracked in git".

---

## Test Plan

### Integration tests

- `plugins/crew/mcp-server/src/tools/__tests__/scan-sources-drift-on-refresh.test.ts` (NEW), three cases per AC2:
  - (a) drift introduced on refresh → no to-do overwrite, `blocked/` manifest written with `blocked_by: "deps-drift"`, `result.depsDriftRefs` populated, `result.blockedRefs` populated, `result.updatedRefs` does NOT contain the ref.
  - (b) non-drift edit on refresh → to-do manifest rewritten with new `source_hash`, `result.updatedRefs` populated, no `blocked/` manifest written, `result.depsDriftRefs` empty for this ref.
  - (c) symmetric drift on refresh (prose adds AND manifest extra) → same `blocked/` outcome as (a), both `proseRefs` and `manifestRefs` arrays reflect the symmetric difference.

### Unit tests

None required. The `checkDepsDrift` helper is already unit-tested via the Story 5.13 test suite (per the 5.13 spec § Test Plan, the helper has both unit coverage in `lib/__tests__/extract-dep-refs.test.ts` and integration coverage in the 5.13 scan-sources tests).

### Smoke test (operator-driven)

Not required. This story has no user-surface ACs; the integration test exercises the same code path the operator's `/crew:scan` invocation would hit.

---

## Developer Context

### Why this story exists (and why now)

Per the epic block: "Added 2026-05-27 from the deep-kettle re-plan (drain follow-ups before re-promoting `dev → main`). Source: review of `scan-sources.ts` after Story 5.13 shipped — the to-do source-hash refresh branch (lines 577-615) rewrites the manifest on source change without calling `checkDepsDrift`, bypassing the gate that Story 5.13 added at lines 404 (blocked-branch) and 496 (currentState === null). Drift introduced by an operator edit after first scan is silently absorbed."

5.13 shipped the gate with two of three relevant call sites wired. This story adds the third. Without it, the gate's contract — "every write to `to-do/` must agree with prose" — leaks via the refresh path: an operator who first authors a clean spec (scan succeeds, manifest lands in `to-do/`), then later edits the spec to add a `Depends on: <ref>` line that the manifest's `depends_on` does not contain, silently passes through the refresh branch with the new hash absorbed. The gate's behavioural contract assumes symmetry across all three branches; this story restores it.

The story is narrowed to two ACs deliberately. Story 5.13 hit a "fail-grade contradiction" at first pass (per its review history) when it tried to cover too much surface area in one story. Keeping 5.16 to one code branch + one test file with three cases avoids that risk.

### Previous-story intelligence

- **Story 5.13** (`5-13-planner-validator-prose-vs-manifest-deps-at-scan-time.md`) shipped the `checkDepsDrift` and `writeDepsDriftBlockedManifest` helpers, the typed `blocked_by: "deps-drift"` enum member, the `ScanResult.depsDriftRefs` field, the `[deps-drift]` render line, and the two existing drift gates at lines 404 (blocked branch) and 496 (currentState === null). Read that spec first — it carries the deps-drift conventions, the helper signatures, and the rendered output shape. The dev agent should re-read `scan-sources.ts` lines 164-237 (the two helpers) before writing the new branch to confirm signatures.
- **Story 3.5** (planning-discipline enforcement) shipped the original to-do refresh branch at lines 577-615. The dev agent should preserve that branch's hand-edit allowance semantics (lines 593-595 comment: "Operator hand-edits to narrative, acceptance_criteria, withdrawn etc. are preserved per Story 3.7's hand-edit allowance"). The new drift gate runs BEFORE the rewrite, so hand-edit preservation is unaffected on the no-drift path.
- **Story 3.7** (hand-edit allowance) is exercised by `__tests__/hand-edit-allowance.integration.test.ts`. The dev agent should consult this file for the fixture pattern when constructing AC2's harness.

### Recent commit context

- `65d1a51 feat(5): fix gh pr view --json baseRepository non-field (#5.15)` — unrelated; substrate canary fix.
- `c6ffe50 feat(5): planner-validator + typed blocked_by enum (#159)` — **this is the 5.13 ship that introduced the helpers this story re-uses.** Re-read the diff before writing.
- `49a834b feat(5): MCP child resilient to parent stdin-close (#158)` — unrelated; 5.12 ship.

### Project memories cited

- `feedback_planner_prose_must_match_manifest` — "prose declarations don't gate behaviour; only manifest fields do. Validate at scan time." This story extends the 5.13 validation to the third branch where it was missing.
- `feedback_default_to_deterministic_seams` — load-bearing decisions live in tool-written artefacts. The drift gate is the deterministic seam; the same `checkDepsDrift` helper is the single source of truth used by all three branches.

### Existing scan-sources test files (audit result)

There is NO dedicated `scan-sources.test.ts` file in `plugins/crew/mcp-server/src/tools/__tests__/` (the only `scan*` file is `scan-orphaned-in-progress.test.ts`, which covers a different tool). The closest fixture patterns live in the integration tests:

- `claim-complete-loop.integration.test.ts` — uses native-adapter scratch repo, exercises the dev loop end-to-end.
- `hand-edit-allowance.integration.test.ts` — exercises the to-do refresh branch from a different angle (hand-edit preservation); use this as the primary fixture pattern for AC2.
- `inner-cycle.integration.test.ts` — broader end-to-end harness.
- `read-backlog-inventory.integration.test.ts` — reads from the same `.crew/state/` layout.

The dev agent SHOULD model `scan-sources-drift-on-refresh.test.ts` after `hand-edit-allowance.integration.test.ts` for the harness shape (same target repo construction, same native adapter seeding, same scan invocation pattern), with the test assertions following the AC2 cases above.

---

## Definition of Done

- [ ] `scan-sources.ts` to-do refresh branch (currently lines 592-610) calls `checkDepsDrift(story)` before `writeManagedFile`; on `driftDetail !== null` the branch follows the same shape as the blocked-branch path at lines 404-426 (writes `blocked/` via `writeDepsDriftBlockedManifest`, pushes to `result.skippedRefs` / `result.blockedRefs` / `result.depsDriftRefs`, continues).
- [ ] `scan-sources-drift-on-refresh.test.ts` lands with three cases per AC2; all three pass.
- [ ] `pnpm -r test` passes (no existing test regressed).
- [ ] `pnpm -r build` clean; `plugins/crew/mcp-server/dist/` committed in the same change.

### Completion note

Ultimate context engine analysis completed — comprehensive developer guide created.
