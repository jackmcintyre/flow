/**
 * Pure classification helper for native story filenames (Story 8.8).
 *
 * The native adapter only ingests `.md` files whose basename matches the
 * Crockford base32 ULID pattern; everything else is silently skipped during
 * a scan (see `adapters/native/index.ts`). That silence means a directory of
 * only-misnamed `.md` files scans to zero with no signal at all.
 *
 * This helper partitions a list of basenames so a caller can distinguish the
 * "nothing matched" condition from a genuinely empty directory and surface a
 * loud warning. Wiring this primitive into the scan's user-facing output is
 * an explicit follow-up — out of scope here.
 *
 * No I/O, no mutation of the input array — pure and deterministic.
 *
 * @see _bmad-output/implementation-artifacts/8-8-native-scan-classify-unmatched-files.md
 */
/** Result of partitioning basenames by the native ULID filename pattern. */
export interface ClassifiedStoryFiles {
    /** Basenames matching the ULID pattern, in input order. */
    matched: string[];
    /** Basenames ending in `.md` but NOT matching the pattern, in input order. */
    unmatched: string[];
}
/**
 * Partition file basenames into ULID-matched and unmatched `.md` files.
 *
 * - `matched`: every basename matching `^[0-9A-HJKMNP-TV-Z]{26}\.md$`.
 * - `unmatched`: every basename ending in `.md` (case-sensitive) that does
 *   NOT match that pattern. A non-empty `unmatched` with an empty `matched`
 *   is the silent-scan ("nothing matched") condition the caller can detect.
 *
 * Basenames not ending in `.md` appear in neither array. Both arrays preserve
 * input order. The input array is never mutated.
 */
export declare function classifyNativeStoryFiles(basenames: readonly string[]): ClassifiedStoryFiles;
