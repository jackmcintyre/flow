/**
 * Unit tests for `extractDepRefsFromSpecBody` — Story 5.13 AC4 + Test Plan.
 *
 * Covers all six edge cases from the spec:
 *   1. Empty body → empty set
 *   2. Single `Depends on: native:<ULID>` line → one element
 *   3. `> Depends on Story 5.10` blockquote → `bmad:5.10`
 *   4. Multiple lines, mixed patterns, deduplicated
 *   5. Malformed refs silently dropped
 *   6. Case sensitivity preserved (`depends on:` lowercase is NOT matched)
 */

import { describe, expect, it } from "vitest";
import { extractDepRefsFromSpecBody } from "../extract-dep-refs.js";

// A valid native ULID ref for use in tests (26 Crockford Base32 chars).
const NATIVE_REF_A = "native:01HZABC000000000000000000A";
const NATIVE_REF_B = "native:01HZABC000000000000000000B";

describe("extractDepRefsFromSpecBody", () => {
  // -------------------------------------------------------------------
  // 1. Empty body
  // -------------------------------------------------------------------

  it("empty body returns empty set", () => {
    const result = extractDepRefsFromSpecBody("");
    expect(result.size).toBe(0);
  });

  it("body with no Depends-on lines returns empty set", () => {
    const body = [
      "# Story 1.1: Example",
      "",
      "## Story",
      "As a dev, I want to test.",
    ].join("\n");
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(0);
  });

  // -------------------------------------------------------------------
  // 2. Pattern (i) — `Depends on: <ref>`
  // -------------------------------------------------------------------

  it("single 'Depends on: native:<ULID>' line yields one element", () => {
    const body = `Depends on: ${NATIVE_REF_A}`;
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(1);
    expect(result.has(NATIVE_REF_A)).toBe(true);
  });

  it("'Depends on: bmad:1.1' yields bmad:1.1", () => {
    const result = extractDepRefsFromSpecBody("Depends on: bmad:1.1");
    expect(result.size).toBe(1);
    expect(result.has("bmad:1.1")).toBe(true);
  });

  it("comma-separated refs on a single Depends on: line yields both", () => {
    const body = `Depends on: ${NATIVE_REF_A}, ${NATIVE_REF_B}`;
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(2);
    expect(result.has(NATIVE_REF_A)).toBe(true);
    expect(result.has(NATIVE_REF_B)).toBe(true);
  });

  it("space-separated refs on a single Depends on: line yields both", () => {
    const body = `Depends on: ${NATIVE_REF_A} ${NATIVE_REF_B}`;
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(2);
  });

  // -------------------------------------------------------------------
  // 3. Pattern (ii) — `> Depends on [Story] <token>`
  // -------------------------------------------------------------------

  it("blockquote '> Depends on Story 5.10' yields bmad:5.10", () => {
    const result = extractDepRefsFromSpecBody("> Depends on Story 5.10");
    expect(result.size).toBe(1);
    expect(result.has("bmad:5.10")).toBe(true);
  });

  it("blockquote '> Depends on 5.11' (without 'Story') yields bmad:5.11", () => {
    const result = extractDepRefsFromSpecBody("> Depends on 5.11");
    expect(result.size).toBe(1);
    expect(result.has("bmad:5.11")).toBe(true);
  });

  it("blockquote '> Depends on Story bmad:1.2' yields bmad:1.2", () => {
    const result = extractDepRefsFromSpecBody("> Depends on Story bmad:1.2");
    expect(result.size).toBe(1);
    expect(result.has("bmad:1.2")).toBe(true);
  });

  it(`blockquote '> Depends on native:<ULID>' yields that ref`, () => {
    const body = `> Depends on ${NATIVE_REF_A}`;
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(1);
    expect(result.has(NATIVE_REF_A)).toBe(true);
  });

  // -------------------------------------------------------------------
  // 4. Mixed patterns with deduplication
  // -------------------------------------------------------------------

  it("same ref in both patterns is deduplicated (Set semantics)", () => {
    const body = [
      `Depends on: bmad:5.10`,
      `> Depends on Story 5.10`,
    ].join("\n");
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(1);
    expect(result.has("bmad:5.10")).toBe(true);
  });

  it("multiple lines from both patterns return union of unique refs", () => {
    const body = [
      `Depends on: bmad:5.10, ${NATIVE_REF_A}`,
      `> Depends on Story 5.11`,
      `> Depends on ${NATIVE_REF_A}`,
    ].join("\n");
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(3);
    expect(result.has("bmad:5.10")).toBe(true);
    expect(result.has("bmad:5.11")).toBe(true);
    expect(result.has(NATIVE_REF_A)).toBe(true);
  });

  // -------------------------------------------------------------------
  // 5. Malformed refs silently dropped
  // -------------------------------------------------------------------

  it("non-ref token after 'Depends on:' is silently dropped", () => {
    const result = extractDepRefsFromSpecBody("Depends on: not-a-ref");
    expect(result.size).toBe(0);
  });

  it("malformed native ref (wrong char set) is silently dropped", () => {
    // Lowercase not allowed in Crockford Base32 (26 chars but lowercase)
    const result = extractDepRefsFromSpecBody("Depends on: native:01hzabc000000000000000000a");
    expect(result.size).toBe(0);
  });

  it("malformed blockquote token is silently dropped", () => {
    const result = extractDepRefsFromSpecBody("> Depends on Story not-a-story");
    expect(result.size).toBe(0);
  });

  it("mixed valid and invalid tokens — invalid ones dropped, valid ones kept", () => {
    const body = `Depends on: bmad:1.1, not-a-ref, ${NATIVE_REF_B}`;
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(2);
    expect(result.has("bmad:1.1")).toBe(true);
    expect(result.has(NATIVE_REF_B)).toBe(true);
  });

  // -------------------------------------------------------------------
  // 6. Case sensitivity
  // -------------------------------------------------------------------

  it("lowercase 'depends on:' is NOT matched (pattern is case-sensitive)", () => {
    const result = extractDepRefsFromSpecBody("depends on: bmad:1.1");
    expect(result.size).toBe(0);
  });

  it("'DEPENDS ON:' uppercase is NOT matched", () => {
    const result = extractDepRefsFromSpecBody("DEPENDS ON: bmad:1.1");
    expect(result.size).toBe(0);
  });

  // -------------------------------------------------------------------
  // Edge cases from spec
  // -------------------------------------------------------------------

  it("no-deps scenario — both sets empty → no drift (empty set returned)", () => {
    const body = "# Story\n\nNo dependencies here.";
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(0);
  });

  it("mid-body blockquote after frontmatter is extracted correctly", () => {
    const body = [
      "# Story 5.11: Orphan recovery",
      "",
      "## Story",
      "As an operator...",
      "",
      "> Depends on Story 5.10",
      "",
      "## Acceptance Criteria",
    ].join("\n");
    const result = extractDepRefsFromSpecBody(body);
    expect(result.size).toBe(1);
    expect(result.has("bmad:5.10")).toBe(true);
  });
});
