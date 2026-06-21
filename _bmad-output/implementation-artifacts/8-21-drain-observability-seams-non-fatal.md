# Story 8.21: Drain observability seams are non-fatal to the run

story_shape: substrate
Status: ready-for-dev

## Story

As an **operator running an unattended drain**,
I want **the drain's progress-heartbeat lines — and any pure-observability seam — to be incapable of aborting a story or the whole run when their underlying courier call hard-fails**,
So that **a transient failure in a logging-only call can never take down work that would otherwise succeed, and Story 8.18's "adds narrator output only, changes no control flow" guarantee holds on every path, not just the happy one**.

This was surfaced by the adversarial review of Story 8.18 (2026-05-31). The progress heartbeat emits a start line and an elapsed done line for each major per-story phase (dev-build, review, gate) through the same one-shot subagent courier the load-bearing steps use. The heartbeat wrappers already degrade gracefully on a *garbled* (non-JSON) relay — they fall back to no line — but neither the wrappers nor the per-story routine catch a *hard* rejection from the underlying courier call, and that routine is awaited with no surrounding guard. So a hard failure on one of the six observability calls per story would propagate and abort the entire drain — the exact opposite of what an observability-only feature should be able to do. The fix is to make read-only / observability seams swallow their own hard failures (degrade to no line, exactly like the garble path), while keeping the load-bearing mutating seams (claim, verdict, gate) fail-loud so a real failure still pauses or blocks that one story with no silent success.

## Dependencies

- Builds directly on Story 8.18 (the progress heartbeat) and must be implemented after it merges, since it hardens the wrappers that story introduces. Reuses the existing degrade convention the seam layer already uses for a garbled relay rather than inventing a new failure channel. No other prerequisite.

## Acceptance Criteria

**AC1 — an observability seam that hard-fails does not propagate; the story proceeds (integration):**

When a progress-heartbeat call's underlying courier hard-fails (throws / rejects, not merely returns a garbled line), the wrapper catches it, emits no progress line, and returns control so the story continues exactly as if the line had been suppressed. A test drives the real drain workflow (seams stubbed) with a progress seam that throws and asserts no exception escapes the run and the story still reaches its normal outcome bucket.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-observability-non-fatal.test.ts

**AC2 — observability cannot alter control flow even on hard failure (integration):**

In a drain run where every progress-heartbeat seam throws, the set of result buckets (completed / merged / pausedForHuman / blocked) and the drain reason are identical to a run where those seams succeed — strengthening Story 8.18's equivalence guarantee from garble-only to hard-failure. The test asserts the two runs produce an identical structured result, differing only in the absence of the progress lines.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-observability-non-fatal.test.ts

**AC3 — the swallow-guard is scoped to read-only / observability seams; mutating seams still fail loud (integration):**

The catch-and-degrade behaviour applies only to observability / read-only seams. A load-bearing mutating step that hard-fails still surfaces — the affected story lands in a paused-or-blocked outcome carrying the failure reason rather than being silently swallowed or treated as a success. The test injects a hard failure into a mutating step and asserts that story is NOT completed and its failure reason is preserved, proving the hardening cannot mask a real failure.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-observability-non-fatal.test.ts

## Notes

Relevant code: the heartbeat wrappers `progressStart` / `progressDone` and the shared `seam()` courier live in `plugins/crew/workflows/drain.workflow.js`; the clock tools `drainPhaseStart` / `drainPhaseDone` are in `plugins/crew/mcp-server/src/tools/drain-phase-progress.ts`. The per-story routine (`processStory`) is awaited in both the orphan-recovery prelude and the main claim loop with no surrounding try/catch — that is why an unguarded hard rejection anywhere inside it aborts the whole run, and it is the reason the guard belongs at the observability-seam boundary (degrade there) rather than by wrapping `processStory` (which would also swallow load-bearing failures and reintroduce silent-success).

Reuse the existing degrade convention: the seam layer already returns a parse-error sentinel on a garbled relay and the wrappers already skip the line in that case; extend the same "no line, keep going" behaviour to a hard rejection of an observability seam. Keep the distinction explicit — only the read-only / idempotent seams (the heartbeat, and any other pure-observability call) get the swallow; the mutating claim / verdict / gate seams keep their fail-loud, no-silent-failure contract (a garble or failure there still pauses or blocks that one story).

Design points to settle during implementation and record in the completion notes: (1) whether the guard lives inside the `progressStart` / `progressDone` wrappers, inside `seam()` gated on a read-only flag, or both — prefer the smallest change that cannot accidentally cover a mutating seam; (2) whether a swallowed hard failure should emit a single quiet diagnostic line (so the operator knows the heartbeat degraded) or nothing at all — pick one and say why.

This is a code change on the orchestration path: rebuild and commit `dist/` in the same change (CI fails on src / dist drift), keep the diff scoped, and run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. It is a `low`-risk, additive guard (it only removes a failure path; it adds no new behaviour to the happy path) and, like its siblings, is expected to pause the auto-merge gate for a human merge — that is correct. Do not write or edit any execution manifest or the team's local ledger files; the tools own the ledger. The literal story ref for this work is bmad:8.21.
