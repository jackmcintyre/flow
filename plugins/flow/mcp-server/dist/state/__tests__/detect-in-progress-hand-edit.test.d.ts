/**
 * Unit tests for `detectInProgressHandEdit` — Story 3.7 Task 3.1, narrowed by Story 5.29.
 *
 * **Story 5.29 — manifest-only baseline.** The check now reads its baseline from a
 * claim-time sidecar at `.flow/state/in-progress/<ref>.snapshot.yaml`. It no longer
 * accepts `sourceHash`/`sourceFields` parameters. Tests seed both the in-progress
 * manifest AND the sidecar to model what `claimStory` writes.
 *
 * Covers:
 *   (c1) hand-edit `title` only → InProgressHandEditError with changedFields:["title"]
 *   (c2) hand-edit `acceptance_criteria` (reorder) → detection via order-sensitive deep-equal
 *   (c3) hand-edit `withdrawn: false → true` → detection
 *   (c4) manifest source_hash drift from sidecar → detection (operator-tampered manifest)
 *   (c5) Story 5.29 regression — source story edit, manifest untouched → { ok: true }
 *   (c6) sidecar missing → InProgressHandEditError with changedFields:["_snapshot_missing"]
 *   (d)  no edit, no drift → { ok: true }
 *
 * Each test seeds a tmpdir with an `in-progress/<ref>.yaml` manifest plus its
 * `<ref>.snapshot.yaml` sidecar, then either mutates the manifest (operator hand-edit)
 * or leaves it intact, then calls `detectInProgressHandEdit` directly.
 *
 * Pure deterministic — no LLM invocation, no network.
 */
export {};
