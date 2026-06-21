# Story 5.29: Hand-edit check uses manifest-only baseline (not live source story)

story_shape: substrate

Status: ready-for-dev

<!-- Authored 2026-05-28 as a follow-up to PR #176 (bmad:6.1) close-out. Sourced from postmortem: processReviewerTranscript refused READY FOR MERGE because deriveSourceBaseline re-reads the live source story, which the dev legitimately edited (implementation_notes). Every Epic 6a close-out repeats this until fixed. -->

## Story

As a **dev/reviewer agent and the operator orchestrating them**,
I want **the in-progress hand-edit check to compare the on-disk in-progress manifest against a baseline captured at claim time, not against the current source story file**,
So that **the legitimate dev workflow of filling `## Implementation Notes` in the source story stops tripping `InProgressHandEditError` and blocking every successful close-out**.

### What this story is, in one sentence

`detectInProgressHandEdit`'s baseline is currently derived from the **live** source story (via `deriveSourceBaseline` → `activeAdapter.readSourceStory`). When the dev edits the source story's Implementation Notes section during a story — which the placeholder text instructs them to do — the next `claimStory`/`completeStory` call sees `source_hash` and `implementation_notes` "drift" between the captured manifest and the recomputed source baseline, throws `InProgressHandEditError`, and refuses to advance. This story narrows the check to manifest-only fields: snapshot the manifest at claim time, compare manifest-to-manifest at completion. Source-story-file tamper detection by re-reading the live source is removed from the in-progress guard.

### Why this story is the right shape

The check's stated intent (see `manifest-state-machine.ts` JSDoc, Story 3.7 FR14) is to detect an **operator hand-editing the manifest mid-flight** — not to detect source-file edits. The current implementation conflates the two because it re-reads the source story to rebuild the baseline. Scoping to manifest-only matches the documented intent and matches the field that the check actually mutates (the `in-progress/<ref>.yaml` file). Source-file tampering, if we ever want to detect it, is a separate concern (`scan-sources` already covers source-hash drift at the `to-do/` layer; that path is untouched).

Option 2 (whitelist `## Implementation Notes` in source-hash computation) was considered and rejected: it adds section-aware hashing logic, makes the heading string load-bearing, and still leaves the door open to false positives if other dev-owned sections are added in future stories. Option 1 is the cleaner mental model.

### Why this blocks the Epic 6 dogfood path

PR #176 (bmad:6.1) hit this defect on close-out and had to be operator-overridden (manual squash-merge + manual manifest move from `in-progress/` to `done/`). Every Epic 6a story that legitimately fills implementation_notes — i.e., every dev-completed story going forward — will repeat the failure until fixed. Per project posture (`dev` is the working trunk; substrate work via `/ship-story`), this is a substrate carry-forward, not an Epic 6 task.

---

## Acceptance Criteria

**AC1:**

`detectInProgressHandEdit` compares the on-disk in-progress manifest against a baseline that was snapshotted at claim time and persisted on the manifest itself (or captured in-process and passed through). It no longer re-reads the source story file to rebuild the baseline. `deriveSourceBaseline` is either removed at the in-progress check call sites (`claimStory` re-entry path, `completeStory`) or its return value is replaced by a manifest-snapshot loader. Source-hash drift between the in-progress manifest and the **current** source story is no longer a hand-edit signal.
artifact: plugins/crew/mcp-server/src/state/manifest-state-machine.ts
artifact: plugins/crew/mcp-server/src/tools/complete-story.ts
artifact: plugins/crew/mcp-server/src/tools/claim-story.ts

**AC2 (integration — regression):**

A vitest test exercises the end-to-end dev-fills-implementation_notes path. Setup: a claimed manifest in `in-progress/` with `implementation_notes` field captured at claim time. Action: simulate the dev's edit by rewriting the source story file's `## Implementation Notes` section (changes source bytes, so the live `source_hash` differs from the manifest's `source_hash`, and the live source's implementation_notes string differs from the manifest's snapshot). Call `completeStory` (or `processReviewerTranscript` → `completeStory` if testing the full path). Assert: the call succeeds (no `InProgressHandEditError`), the manifest moves from `in-progress/` to `done/`, and no source-file drift is reported. This test is the regression guard for PR #176's defect.
vitest: plugins/crew/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts

**AC3 (integration — no false negatives):**

A vitest test confirms operator manifest-tampering is still detected after the narrowing. Setup: a claimed manifest in `in-progress/`. Action: hand-edit the in-progress manifest file directly (e.g., flip `withdrawn`, reorder `acceptance_criteria`, change `title`) while leaving the source story file untouched. Call `claimStory` re-entry or `completeStory`. Assert: `InProgressHandEditError` is thrown with the correct `changedFields` array. This covers the existing c1–c3 hand-edit cases (`title`, `acceptance_criteria`, `withdrawn`) — each must remain detected.
vitest: plugins/crew/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts

**AC4:**

`detectInProgressHandEdit` JSDoc is updated to reflect the new contract: "compares the on-disk in-progress manifest against the claim-time manifest snapshot; does not consult the source story file." The Story 3.7 caller contract reference is updated to point at this story. `deriveSourceBaseline` either has its JSDoc updated to note it is no longer used by the in-progress guard (if retained for other reasons) or is removed entirely if no remaining call sites exist. The c4 case in the existing test file (`source hash drift detected`) is updated or removed so the test name no longer implies source-file drift detection from the in-progress guard.
artifact: plugins/crew/mcp-server/src/state/manifest-state-machine.ts
artifact: plugins/crew/mcp-server/src/state/derive-source-baseline.ts
artifact: plugins/crew/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts

---

## Implementation Notes

### Recommended fix shape (option 1 — scope-narrow)

The cleanest implementation captures the claim-time manifest snapshot **on the manifest itself** so the check stays pure-functional and side-effect-free at completion time:

1. **At claim time** (`claimStory`): when writing the manifest into `in-progress/<ref>.yaml`, the manifest already contains the operator-editable fields (title, narrative, acceptance_criteria, implementation_notes, depends_on, withdrawn) and `source_hash` as they were at scan time. That **is** the snapshot. No new field needed.
2. **At completion / re-entry time** (`completeStory`, `claimStory` re-entry path): instead of calling `deriveSourceBaseline` (which reads the live source story), load the manifest from `in-progress/<ref>.yaml` **twice** — once as the "expected baseline" (treating the on-disk file as authoritative for the snapshot, since nothing should have changed) and once… no, that's wrong. The simpler shape:
   - The check's purpose is "has the in-progress manifest been tampered with since it was written?". The only thing that could tamper with it is an operator hand-edit between when claim wrote it and when complete reads it. If we **trust** the manifest's own contents as the baseline (it's what we last wrote), then the check collapses to a tautology — it can't detect a hand-edit at all.
   - **Therefore the snapshot must be captured separately and persisted.** Two viable seams:
     - **(a) Sidecar file:** when `claimStory` writes `in-progress/<ref>.yaml`, also write `in-progress/<ref>.snapshot.yaml` (or `.snapshot.json`) containing the same operator-editable-fields + source_hash. The check compares the main manifest against the sidecar. The sidecar is removed when the manifest moves to `done/` or back to `to-do/`.
     - **(b) Embedded snapshot block:** add a `_claim_snapshot:` field to `ExecutionManifest` (in-progress-only), written by `claimStory` and read by the check. The schema would need a `.passthrough()` or explicit optional field. The check reads the manifest, separates `_claim_snapshot` from the rest, and compares the two.
   - **Recommend (a) sidecar.** Reasons: (i) keeps `ExecutionManifest` schema clean — no schema changes, no risk of the snapshot field leaking into `to-do/` or `done/` manifests; (ii) the sidecar is trivially removable on state transitions; (iii) tampering with the sidecar is itself a hand-edit signal (an operator who knows how to forge the sidecar to match a hand-edited manifest is past the point where any guard helps).

3. **At `complete`/transition out of `in-progress/`:** remove the sidecar atomically with the manifest move. Use the same atomic-rename primitive (Story 1.6) — rename the manifest, then `unlink` the sidecar (best-effort; a stale sidecar without a manifest is recoverable).

### Files touched

**MODIFY:**

- `plugins/crew/mcp-server/src/tools/claim-story.ts` — at the point where the manifest is written into `in-progress/`, also write the sidecar snapshot. Wrap the two writes so a failure of either leaves no half-claimed state (rollback the manifest write if the sidecar write fails; or write sidecar first, then atomic-rename manifest, so a stale sidecar is harmless).
- `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` — change `detectInProgressHandEdit`'s signature: remove `sourceHash` and `sourceFields` parameters; load the sidecar from `in-progress/<ref>.snapshot.yaml` inside the function and compare against the on-disk manifest. Update the JSDoc per AC4.
- `plugins/crew/mcp-server/src/tools/complete-story.ts` — remove the `deriveSourceBaseline` call; just call `detectInProgressHandEdit({ targetRepoRoot, ref })`. On successful transition to `done/`, unlink the sidecar (or rely on the manifest-move primitive to do it — see Story 1.6's seam).
- `plugins/crew/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts` — update existing c1/c2/c3 cases to set up the sidecar correctly (test helpers should write both manifest and sidecar). Update or remove c4 (source-hash drift) — under the new contract, source-hash drift between the manifest and the **sidecar** still flags as a hand-edit (because the operator hand-edited `source_hash` in the manifest), but source-hash drift between the manifest and the live source story is no longer the trigger. Add the new AC2 regression case.

**Consider removing (only if no other call sites remain):**

- `plugins/crew/mcp-server/src/state/derive-source-baseline.ts` — grep for `deriveSourceBaseline` import sites across the codebase before removing. If there are none, delete the file and its test. If any callers remain (e.g., `scan-sources` may compute a similar baseline for its own purposes), leave the file and update its JSDoc to clarify it is no longer used by the in-progress guard.

**UNTOUCHED (DO NOT modify):**

- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — source-hash drift at the `to-do/` layer (when a source story changes and a manifest in `to-do/` needs refreshing) is a separate concern and is already handled here. This story does not touch that path.
- `plugins/crew/mcp-server/src/errors.ts` — `InProgressHandEditError` shape is unchanged. Only the conditions under which it fires change.
- Adapter `readSourceStory` implementations (BMad, native) — unchanged.

### Build artefacts

After any change in `plugins/crew/mcp-server/src/`, the dev agent MUST run `pnpm -r build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git".

### Dependencies

None. Leaf story. The change is self-contained inside the state-machine + the two callers (`claimStory`, `completeStory`). No new MCP tools, no schema changes (sidecar is a separate file with the same `OperatorEditableFields` shape, written as YAML to mirror the main manifest).

### Root cause summary (for AC4 — embedded here, not a separate retro)

`deriveSourceBaseline` was added in Story 4.1 as the helper that gives `detectInProgressHandEdit` its `{ sourceHash, sourceFields }` baseline. Its implementation reads the **live** source story via the active adapter — which means every call to the check recomputes the baseline from the current state of the source story file on disk. This is the wrong reference point: the check should compare against what the source looked like **when the manifest was claimed**, not what it looks like now. The fix is to capture the baseline at claim time (sidecar file) and stop re-reading the source story inside the guard.

This defect did not surface in Epic 4 because Epic 4 stories did not exercise the dev-fills-implementation_notes workflow end-to-end against the real adapter — the existing test for `detectInProgressHandEdit` c4 ("source hash drift detected") was treating the drift as a legitimate hand-edit signal, masking the conflation.

---

## Definition of Done

- [ ] Sidecar snapshot is written by `claimStory` when a manifest enters `in-progress/`, and removed when the manifest leaves (to `done/` or back to `to-do/`).
- [ ] `detectInProgressHandEdit` no longer accepts `sourceHash`/`sourceFields` parameters and no longer calls `deriveSourceBaseline` (directly or indirectly). The check loads the sidecar and compares against the on-disk manifest.
- [ ] `completeStory` and `claimStory` re-entry path call the new signature; no `deriveSourceBaseline` call remains on the in-progress guard path.
- [ ] AC2 regression test lands and passes: dev-edits-source-implementation_notes → completeStory succeeds.
- [ ] AC3 false-negative tests pass: operator hand-edits to `title`, `acceptance_criteria`, `withdrawn` on the in-progress manifest still throw `InProgressHandEditError`.
- [ ] Existing c1/c2/c3 cases in `detect-in-progress-hand-edit.test.ts` updated to set up the sidecar; c4 updated or removed per the new contract.
- [ ] JSDoc on `detectInProgressHandEdit` rewritten per AC4.
- [ ] `pnpm -r build` clean; `dist/` committed in the same change.
- [ ] `pnpm -r test` passes (all existing claim/complete/reviewer-transcript tests still green; no other call sites of `deriveSourceBaseline` are broken by its removal or signature change).
