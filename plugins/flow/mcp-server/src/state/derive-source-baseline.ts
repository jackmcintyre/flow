/**
 * `deriveSourceBaseline` — source-hash + source-fields derivation helper.
 *
 * **Story 5.29: NO LONGER USED BY THE IN-PROGRESS HAND-EDIT GUARD.**
 *
 * Originally (Story 4.1) this helper supplied `{ sourceHash, sourceFields }` to
 * `detectInProgressHandEdit` by reading the live source story via the active
 * adapter. That conflated two concerns: legitimate dev-driven edits to the
 * source story (e.g. filling `## Implementation Notes`) tripped the in-progress
 * hand-edit check on every close-out (PR #176 was the failure mode).
 *
 * Under Story 5.29's contract, `detectInProgressHandEdit` reads its baseline
 * from a claim-time sidecar file (`<ref>.snapshot.yaml`) — not from the live
 * source story. `claimStory` and `completeStory` no longer call this helper.
 *
 * The function is retained because no other call sites are currently broken
 * by its presence and removing it would force wide test-mock rework across
 * eight test files that still declare module mocks for it. If a future change
 * needs source-story-baseline derivation for an unrelated purpose, this is
 * still the right shape. If no future caller emerges, this file can be
 * deleted alongside its dependent test mocks.
 *
 * Co-located with `manifest-state-machine.ts` for historical reasons.
 *
 * Story 4.1 — Task 5 (original).
 * Story 5.29 — removed from in-progress-guard call sites.
 */

import { resolveWorkspace } from "./workspace-resolver.js";
import type { OperatorEditableFields } from "./manifest-state-machine.js";

export interface SourceBaseline {
  /** SHA-256 hex digest of the source story's raw bytes. */
  sourceHash: string;
  /** Operator-editable field values at source-story read time. */
  sourceFields: OperatorEditableFields;
}

/**
 * Derive the canonical hand-edit baseline for a ref by reading the current
 * source story via the active adapter.
 *
 * The baseline mirrors what `scan-sources` would write: `sourceHash` comes
 * from `SourceStory.source_hash` (computed by the adapter from the raw bytes),
 * and `sourceFields` are the six operator-editable fields extracted from the
 * same `SourceStory`.
 *
 * **Edge case:** If the source story has been deleted from the planning tool
 * (BMad file removed; native file removed), `readSourceStory` throws (e.g.
 * `UnknownBmadRefError`). In that case this helper propagates the error —
 * `claimStory` and `completeStory` cannot proceed against a source-less ref.
 * The orchestrator will surface this as a state inconsistency.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."` or `"bmad:1.1"`).
 * @throws When the active adapter's `readSourceStory` fails (source deleted,
 *   workspace not resolved, etc.).
 */
export async function deriveSourceBaseline(opts: {
  targetRepoRoot: string;
  ref: string;
}): Promise<SourceBaseline> {
  const { targetRepoRoot, ref } = opts;

  const workspace = await resolveWorkspace({ targetRepoRoot });
  const sourceStory = await workspace.activeAdapter.readSourceStory(ref);

  const sourceFields: OperatorEditableFields = {
    title: sourceStory.title,
    narrative: sourceStory.narrative,
    acceptance_criteria: sourceStory.acceptance_criteria,
    implementation_notes: sourceStory.implementation_notes,
    depends_on: sourceStory.depends_on,
    withdrawn: false,
  };

  return {
    sourceHash: sourceStory.source_hash,
    sourceFields,
  };
}
