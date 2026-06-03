/**
 * `mintSessionUlid` MCP tool — Story 4.2 Task 2.
 *
 * Pure ULID-minting helper. No IO, no filesystem touch, no telemetry.
 *
 * Purpose: the LLM-driven `/flow:start` skill MUST NOT ask the LLM to
 * "generate a ULID" — that path is non-deterministic and risks collision /
 * shape drift. This tool delegates minting to the `ulid` npm package
 * (already a transitive dep since Story 3.2's native-story refs).
 *
 * The tool exists solely so the LLM-driven skill cannot improvise ULIDs.
 * Its return is deterministic: every call produces a valid, monotonic,
 * unique ULID string.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `mintSessionUlid`.
 * Story 4.2 Task 2.1 / 2.2 / 2.3.
 */
import { ulid } from "ulid";
/**
 * Mint a single session ULID. Pure — no side-effects, no IO.
 *
 * The returned string is a valid ULID (26 characters, Crockford Base32,
 * monotonically increasing within the same millisecond).
 */
export function mintSessionUlid() {
    return { sessionUlid: ulid() };
}
