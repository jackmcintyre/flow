/**
 * Unit tests for `detectChangeTypes` — AC4 sub-case (4j).
 *
 * Story 4.9b — FR40a detector heuristics.
 */
import { describe, it, expect } from "vitest";
import { detectChangeTypes } from "../detect-change-types.js";
describe("detectChangeTypes", () => {
    // --- Migration ---
    it("detects migration from migrations/ path", () => {
        expect(detectChangeTypes(["db/migrations/0042.sql"], [])).toEqual(["migration", "schema"]);
    });
    // Note: db/migrations/0042.sql also matches *.sql → "schema". We test schema separately.
    it("detects schema from prisma/schema.prisma", () => {
        expect(detectChangeTypes(["prisma/schema.prisma"], [])).toEqual(["schema"]);
    });
    it("detects schema from db/schema.sql (schema.{sql,...} pattern)", () => {
        expect(detectChangeTypes(["db/schema.sql"], [])).toEqual(["schema"]);
    });
    // --- Dep bump ---
    it("detects dep-bump from package.json and pnpm-lock.yaml", () => {
        expect(detectChangeTypes(["package.json", "pnpm-lock.yaml"], [])).toEqual(["dep-bump"]);
    });
    it("detects dep-bump from Cargo.lock", () => {
        expect(detectChangeTypes(["Cargo.lock"], [])).toEqual(["dep-bump"]);
    });
    // --- Revert ---
    it("detects revert from commit message prefix", () => {
        expect(detectChangeTypes([], ['Revert "feat: foo"'])).toEqual(["revert"]);
    });
    // --- No types ---
    it("returns [] for a plain TypeScript file with no revert commit", () => {
        expect(detectChangeTypes(["src/foo.ts"], ["fix: bar"])).toEqual([]);
    });
    // --- Multi-type, sorted ---
    it("detects dep-bump and migration (sorted) for mixed paths", () => {
        expect(detectChangeTypes(["db/migrations/0001.sql", "package.json"], [])).toEqual([
            "dep-bump",
            "migration",
            "schema", // db/migrations/0001.sql also matches *.sql
        ]);
    });
    // --- Empty inputs ---
    it("returns [] for empty inputs", () => {
        expect(detectChangeTypes([], [])).toEqual([]);
    });
    // --- Deduplicated ---
    it("deduplicates when multiple paths trigger the same type", () => {
        const result = detectChangeTypes(["package.json", "pnpm-lock.yaml", "yarn.lock"], []);
        expect(result).toEqual(["dep-bump"]);
    });
    // --- Revert case-sensitive ---
    it("does not detect revert on lowercase 'revert'", () => {
        expect(detectChangeTypes([], ['revert "feat: foo"'])).toEqual([]);
    });
    // --- migration/ singular ---
    it("detects migration from migration/ (singular) path", () => {
        expect(detectChangeTypes(["db/migration/0001.sql"], [])).toEqual(["migration", "schema"]);
    });
});
