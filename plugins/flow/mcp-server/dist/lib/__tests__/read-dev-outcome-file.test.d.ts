/**
 * Unit tests for `readDevOutcomeFile` / `devOutcomeFilePath`.
 *
 * Story native:01KT3YDHM10FPQ77N22BTJP9AF (AC2): the dev-outcome (PR-pointer)
 * record is namespaced per story ref under a session, so when one story's record
 * is written while another's is being written in the same run (same session
 * ULID, different refs), reading either back returns THAT story's own PR — and
 * neither record overwrites or cross-attributes the other.
 *
 * Before the per-ref fix every story in a drain run wrote to a single shared
 * `sessions/<ulid>/dev-outcome.json`, so a later/concurrent write clobbered an
 * earlier story's PR record — the 2026-06-02 cross-attribution regression.
 */
export {};
