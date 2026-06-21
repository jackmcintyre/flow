# Story 8.10: Plain-language explanation of auto-merge gate reasons

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a pure helper that turns an auto-merge gate reason code into a one-line plain-language explanation**,
So that **when the gate pauses or merges a PR I can read why in plain terms, without memorising the reason literals**.

This is the Stage-2-for-code dogfood guinea pig (Epic 8): a small, self-contained, purely-additive code helper the autonomous drain builds, verifies, CI-gates, and auto-merges end-to-end with zero human intervention. It is the first real *code* (not docs) the loop merges on its own. One new module plus its unit test — no existing file is modified.

## Dependencies

- None. Leaf story: one new pure module plus its unit test. No I/O, no state, no imports from existing modules.

## Acceptance Criteria

**AC1 — maps each known gate reason to a non-empty plain-language explanation:**

`explainGateReason(reason)` is a new exported pure function in `plugins/crew/mcp-server/src/lib/explain-gate-reason.ts`. Given any of the known auto-merge gate reason strings — `"low-risk-met-threshold"`, `"low-risk-sub-threshold"`, `"low-risk-insufficient-data"`, `"low-risk-provisional-trust"`, `"medium-risk"`, `"high-risk"`, `"no-tier-no-signal"`, `"ci-not-green"` — it returns a non-empty, human-readable one-line string (no newline characters) that accurately describes what that reason means for the merge decision. The function is pure and deterministic — no I/O, no mutation.
vitest: plugins/crew/mcp-server/src/lib/__tests__/explain-gate-reason.test.ts

**AC2 — returns a safe fallback for an unknown reason and never throws:**

Given a reason string that is not one of the known literals (including the empty string), `explainGateReason` returns a non-empty generic fallback explanation (e.g. mentioning an unrecognized reason) rather than throwing or returning an empty string. The function never throws for any string input.
vitest: plugins/crew/mcp-server/src/lib/__tests__/explain-gate-reason.test.ts

## Notes

Keep it tiny and self-contained — a single pure function (a map/switch over the reason literals plus a fallback) and a focused unit test, mirroring Story 8.7/8.8's shape. Do NOT import from or modify any existing module: accept a plain `string` and return a `string` so the PR's diff is purely new files (this keeps it classified `low.additive-only`). Run `pnpm --dir plugins/crew/mcp-server build && pnpm --dir plugins/crew/mcp-server test` GREEN before opening the PR, and commit the rebuilt `dist/`. Do not touch the execution manifest or any `.crew/state` file.
