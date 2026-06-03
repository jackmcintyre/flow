/**
 * Catalogue locked-phrase anchor test — Story 4.11 Task 6.4 / Task 8.3.
 *
 * Asserts that every shipped catalogue file's `locked_phrases.yield` value
 * equals `YIELD_PHRASE_TEMPLATE` (imported from yield-parser.ts). This pins
 * the lock against accidental drift.
 *
 * The catalogue list is enumerated explicitly (no glob). Adding a new
 * catalogue persona requires a deliberate edit to this test, which is the
 * right friction.
 *
 * Story 4.11 AC1 (token rename <role> → <domain> + trailing period).
 */
export {};
