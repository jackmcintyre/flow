# Story 8.8: Native scan classifies unmatched story files

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **the native adapter to identify `.md` files in the stories directory that do NOT match the ULID filename pattern, instead of silently discarding them**,
So that **a misnamed story file can be surfaced loudly rather than vanishing — today a directory of only-misnamed files scans to zero with no signal at all**.

This is the second Stage-1 stateless-drain dogfood story (Epic 8): a small, low-risk, pure additive helper the autonomous drain builds end-to-end. It re-validates the autonomous loop and CI after the base-branch fix (#191). It delivers the classification primitive the "loud-arm" scan warning will build on; wiring that primitive into the scan's user-facing output is an explicit follow-up, out of scope here. No I/O, no side effects, no existing files changed.

## Dependencies

- None. Leaf story: one new pure module plus its unit test. Does not read the filesystem or mutate any state.

## Acceptance Criteria

**AC1 — partitions basenames into ULID-matched and unmatched `.md` files:**

`classifyNativeStoryFiles(basenames)` is a new exported pure function in `plugins/crew/mcp-server/src/adapters/native/classify-story-files.ts`. Given an array of file basenames (strings), it returns an object `{ matched: string[], unmatched: string[] }` where `matched` contains every basename matching the native ULID pattern `^[0-9A-HJKMNP-TV-Z]{26}\.md$` and `unmatched` contains every basename that ends in `.md` (case-sensitive) but does NOT match that pattern. Basenames that do not end in `.md` appear in neither array. Both arrays preserve the input order. The function is pure and deterministic — no I/O, no mutation of the input array.
vitest: plugins/crew/mcp-server/src/adapters/native/__tests__/classify-story-files.test.ts

**AC2 — handles the all-unmatched and empty cases without throwing:**

Given basenames where one or more entries end in `.md` but none match the ULID pattern (e.g. `["my-story.md", "draft.md"]`), `classifyNativeStoryFiles` returns `matched: []` and an `unmatched` array containing every non-conforming `.md` name — this is the silent-scan ("nothing matched") condition the caller can now detect. Given an empty array, or an array with only non-`.md` names (e.g. `["README.txt", "notes"]`), both `matched` and `unmatched` are empty. The function never throws for any string-array input.
vitest: plugins/crew/mcp-server/src/adapters/native/__tests__/classify-story-files.test.ts

## Notes

Keep it tiny — a single pure function and a focused unit test, mirroring Story 8.7's shape. Reuse the existing ULID pattern from `adapters/native/index.ts` (`NATIVE_FILENAME_RE`, `^[0-9A-HJKMNP-TV-Z]{26}\.md$`) — do not invent a new one. Run `pnpm --dir plugins/crew/mcp-server build && pnpm --dir plugins/crew/mcp-server test` GREEN before opening the PR. Do not modify `index.ts`, the execution manifest, or any `.crew/state` file — this story is purely additive.
