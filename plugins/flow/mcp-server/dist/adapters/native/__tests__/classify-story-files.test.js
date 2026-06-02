/**
 * Unit tests for `classifyNativeStoryFiles` — Story 8.8.
 *
 * Pure function: no I/O, no fixtures. Covers AC1 (partition into matched /
 * unmatched, order preservation, no mutation) and AC2 (all-unmatched, empty,
 * and non-`.md`-only inputs; never throws).
 */
import { describe, it, expect } from "vitest";
import { classifyNativeStoryFiles } from "../classify-story-files.js";
/** A valid 26-char Crockford base32 ULID basename. */
const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV.md";
const ULID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ.md";
describe("classifyNativeStoryFiles — AC1 (partition matched / unmatched)", () => {
    it("places ULID-named files in matched and other .md files in unmatched", () => {
        const result = classifyNativeStoryFiles([ULID_A, "my-story.md", ULID_B, "draft.md"]);
        expect(result.matched).toEqual([ULID_A, ULID_B]);
        expect(result.unmatched).toEqual(["my-story.md", "draft.md"]);
    });
    it("excludes basenames not ending in .md from both arrays", () => {
        const result = classifyNativeStoryFiles([ULID_A, "README.txt", "notes", "image.png"]);
        expect(result.matched).toEqual([ULID_A]);
        expect(result.unmatched).toEqual([]);
    });
    it("preserves input order within each array", () => {
        const result = classifyNativeStoryFiles([
            ULID_B,
            "zebra.md",
            ULID_A,
            "alpha.md",
        ]);
        expect(result.matched).toEqual([ULID_B, ULID_A]);
        expect(result.unmatched).toEqual(["zebra.md", "alpha.md"]);
    });
    it("is case-sensitive: lowercase-ULID-like .md goes to unmatched", () => {
        // Same 26 chars as ULID_A but lowercased — must NOT match the pattern.
        const lower = "01arz3ndektsv4rrffq69g5fav.md";
        const result = classifyNativeStoryFiles([lower]);
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual([lower]);
    });
    it("treats excluded ULID alphabet letters (I, L, O, U) as unmatched", () => {
        // 26-char name using I/L/O/U which are NOT in the Crockford base32 alphabet.
        const badAlpha = "01ILOU3NDEKTSV4RRFFQ69G5FA.md";
        const result = classifyNativeStoryFiles([badAlpha]);
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual([badAlpha]);
    });
    it("does not mutate the input array", () => {
        const input = [ULID_A, "my-story.md"];
        const snapshot = [...input];
        classifyNativeStoryFiles(input);
        expect(input).toEqual(snapshot);
    });
    it("is deterministic — repeated calls yield equal results", () => {
        const input = [ULID_A, "x.md", "y.txt"];
        expect(classifyNativeStoryFiles(input)).toEqual(classifyNativeStoryFiles(input));
    });
});
describe("classifyNativeStoryFiles — AC2 (all-unmatched, empty, non-.md only)", () => {
    it("returns matched: [] and all names in unmatched when nothing matches (silent-scan condition)", () => {
        const result = classifyNativeStoryFiles(["my-story.md", "draft.md"]);
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual(["my-story.md", "draft.md"]);
    });
    it("returns both arrays empty for an empty input", () => {
        const result = classifyNativeStoryFiles([]);
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual([]);
    });
    it("returns both arrays empty when no basename ends in .md", () => {
        const result = classifyNativeStoryFiles(["README.txt", "notes"]);
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual([]);
    });
    it("never throws for any string-array input, including odd strings", () => {
        expect(() => classifyNativeStoryFiles(["", ".md", "x.md.md", "....md", "  .md", "MD", "story.MD"])).not.toThrow();
        const result = classifyNativeStoryFiles(["", ".md", "x.md.md", "....md"]);
        // ".md" alone, "x.md.md", "....md" all end in ".md" but don't match the ULID pattern.
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual([".md", "x.md.md", "....md"]);
    });
    it("treats uppercase .MD extension as non-matching and non-.md (case-sensitive)", () => {
        const result = classifyNativeStoryFiles(["story.MD", "01ARZ3NDEKTSV4RRFFQ69G5FAV.MD"]);
        expect(result.matched).toEqual([]);
        expect(result.unmatched).toEqual([]);
    });
});
