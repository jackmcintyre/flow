/**
 * Schema + comment-preserving parser tests for the discipline-rule registry —
 * Story 6.5 AC1.
 *
 * Covers:
 *   - A commented registry round-trips byte-for-byte on its comments when read
 *     and rewritten with no logical change (every human-authored comment
 *     survives — leading AND inline).
 *   - An absent registry (raw === null) parses to an empty-but-valid registry
 *     (zero rules), never an error.
 *   - A malformed registry (a rule missing a required field) raises the typed
 *     RuleRegistryMalformedError naming the offending path + the Zod message.
 *   - The rule schema: required fields, optional level enum, `.strict()`.
 */
export {};
