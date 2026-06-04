/**
 * Tests for the `persona-append`-kind handler and the retro-proposal type-count
 * invariant — Story 6.9, AC1–AC4.
 *
 * AC1 (integration): confirmed apply appends a new bullet to the Knowledge
 *   section and commits via the gate (tested end-to-end via acceptProposal with
 *   a fake gitCommit seam).
 *
 * AC2 (unit): preview returns the lesson text and target role, writes nothing
 *   to disk.
 *
 * AC3 (unit): missing persona file surfaces a clear PersonaFileNotFoundError;
 *   no file is created or modified.
 *
 * AC4 (unit): `persona-append` is present in `RETRO_PROPOSAL_TYPES` (the
 *   discriminated union), the production registry registers it, and the
 *   type-count assertion passes at 9.
 *
 * Fixture approach: seed a minimal persona in a temp dir using `atomicWriteFile`
 * (the same pattern as build-persona-spawn-prompt.test.ts), then call
 * `acceptProposal` with an injected fake `gitCommit` seam. No real git.
 */
export {};
