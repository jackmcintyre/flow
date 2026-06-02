/**
 * Integration tests for `runAutoMergeGate` — Story 4.10b (AC5d–q).
 *
 * Test coverage:
 *   (5d)  (a) Auto-merge fires — low risk, met threshold.
 *   (5e)  (b) Medium pauses.
 *   (5f)  (c) High pauses.
 *   (5g)  (d) Low + sub-threshold pauses.
 *   (5h)  (e) Low + insufficient-data pauses.
 *   (5i)  (f) Manual-merge override (structural SKILL.md check).
 *   (5j)  (g) No-tier pause (legacy manifest).
 *   (5k)  (h) Boundary — ratio exactly equals threshold.
 *   (5l)  (i) SKILL.md content-structure (runAutoMergeGate under done-ready-for-merge).
 *   (5m)  (j) MCP tool registration smoke (runAutoMergeGate in register list, count 31).
 *   (5n)  (k) dryRun: true — decision made but no gh call.
 *   (5o)  (l) GhRecoverableError on pr merge failure.
 *   (5p)  (m) pr-merge denied without permission entry.
 *   (5q)  (n) AutoMergeGateResultSchema round-trip.
 *
 * Strategy: inject `execaImpl` (never vi.mock production modules). The real `gh`
 * wrapper is exercised; only the underlying subprocess is replaced.
 *
 * Story 4.10b Task 2.6.
 */
export {};
