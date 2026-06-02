/**
 * Unit tests for ship_gate field surfacing in `parseBmadStory` (Story 3.5 Task 4.3).
 *
 * Tests that:
 *   - A BMad story with a `Tags: ship-gate` line has `raw_frontmatter.ship_gate === true`.
 *   - A BMad story without any tags line has `raw_frontmatter.ship_gate === undefined`.
 *   - The ship_gate field is case-insensitive for the tag match.
 */

import { describe, it, expect } from "vitest";
import { parseBmadStory } from "../parse-bmad-story.js";

const BASE_STORY = (extra = "") => `
# Story 1.1: Test story

Status: backlog
${extra}
## Story

As a **fixture**, I want **to test ship-gate**, so that **it works**.

## Acceptance Criteria

**AC1:**
**Given** a story, **When** parsed, **Then** ship_gate is surfaced.
`.trimStart();

describe("parseBmadStory — ship_gate field (Story 3.5 Task 4)", () => {
  it("sets raw_frontmatter.ship_gate = true when Tags: contains 'ship-gate'", () => {
    const content = BASE_STORY("Tags: ship-gate");
    const result = parseBmadStory("/fake/1-1-test-story.md", content);
    expect(result.raw_frontmatter["ship_gate"]).toBe(true);
  });

  it("sets raw_frontmatter.ship_gate = true for mixed-case 'Ship-Gate' tag", () => {
    const content = BASE_STORY("Tags: Ship-Gate, other-tag");
    const result = parseBmadStory("/fake/1-1-test-story.md", content);
    expect(result.raw_frontmatter["ship_gate"]).toBe(true);
  });

  it("sets raw_frontmatter.ship_gate = true for lowercase tags: line", () => {
    const content = BASE_STORY("tags: release, ship-gate");
    const result = parseBmadStory("/fake/1-1-test-story.md", content);
    expect(result.raw_frontmatter["ship_gate"]).toBe(true);
  });

  it("leaves raw_frontmatter.ship_gate undefined when no Tags: line present", () => {
    const content = BASE_STORY();
    const result = parseBmadStory("/fake/1-1-test-story.md", content);
    expect(result.raw_frontmatter["ship_gate"]).toBeUndefined();
  });

  it("leaves raw_frontmatter.ship_gate undefined when Tags: does not contain 'ship-gate'", () => {
    const content = BASE_STORY("Tags: feature, enhancement");
    const result = parseBmadStory("/fake/1-1-test-story.md", content);
    expect(result.raw_frontmatter["ship_gate"]).toBeUndefined();
  });

  it("does not set ship_gate when the tag line appears after the first section heading", () => {
    // Tags after ## Story heading are not in the preamble and should be ignored.
    const content = `
# Story 1.1: Test story

Status: backlog

## Story

Tags: ship-gate

As a fixture, I want to test.

## Acceptance Criteria

**AC1:**
**Given** a story, **When** parsed, **Then** ship_gate is checked.
`.trimStart();
    const result = parseBmadStory("/fake/1-1-test-story.md", content);
    expect(result.raw_frontmatter["ship_gate"]).toBeUndefined();
  });
});
