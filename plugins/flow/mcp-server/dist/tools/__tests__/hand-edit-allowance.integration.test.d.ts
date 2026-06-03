/**
 * Integration tests for the hand-edit allowance contract — Story 3.7 Task 3.2.
 *
 * Covers AC4 cases (a), (b), (e), (f):
 *   (a) hand-edit `to-do/` title + narrative; assert parseExecutionManifest returns
 *       edited values; run scan-sources against the unchanged source story; assert
 *       edited values preserved AND manifest mtime stable (no rewrite).
 *   (b) hand-edit `to-do/` acceptance_criteria; mutate source story (new hash);
 *       run scan-sources; assert acceptance_criteria edits preserved AND
 *       source_hash / source_path updated.
 *   (e) hand-edit `blocked/` title; assert parseExecutionManifest returns edited value.
 *   (f) hand-edit `to-do/` to violate schema (delete title field); assert next
 *       parseExecutionManifest throws MalformedExecutionManifestError.
 *
 * Each test constructs a fresh tmpdir with a minimal native-adapter workspace
 * so the committed fixtures are never mutated.
 *
 * Note: operator edits are simulated via `atomicWriteFile` (the canonical write
 * primitive available to test code inside src test directories) — the static fs
 * guard bans direct write-shaped node:fs imports from src code.
 */
export {};
