/**
 * Unit tests for `renderExpectedWorkCounters` — Story native:01KTSR3E7FE61XB2PN8VJ24289 AC4.
 *
 * AC4: Given a scan or run where nothing was skipped, rejected, or held, When
 * the operator reads the summary, Then the same counter line is shown reading
 * zero across the board, so a true "all clear" is an explicit zero count rather
 * than the absence of any message.
 *
 * Pure function — no filesystem, no clock.
 */

import { describe, expect, it } from "vitest";
import {
  renderExpectedWorkCounters,
  type ExpectedWorkCounters,
} from "../../lib/expected-work-counters.js";

describe("renderExpectedWorkCounters — pure render helper", () => {
  it("AC4 (all clear): renders an explicit zero-count line when nothing was skipped, rejected, or held", () => {
    const counters: ExpectedWorkCounters = {
      filesSeenCount: 0,
      filesRejected: [],
      refsHeld: [],
    };
    const output = renderExpectedWorkCounters(counters);
    // The line must be present and must mention zero for all three counters.
    expect(output).toContain("expected-work:");
    expect(output).toContain("0 rejected");
    expect(output).toContain("0 held");
    // The line must not be absent even when everything is zero.
    expect(output.length).toBeGreaterThan(0);
  });

  it("renders files-seen count when files exist but none are rejected or held", () => {
    const counters: ExpectedWorkCounters = {
      filesSeenCount: 5,
      filesRejected: [],
      refsHeld: [],
    };
    const output = renderExpectedWorkCounters(counters);
    expect(output).toContain("5 file(s) seen");
    expect(output).toContain("0 rejected");
    expect(output).toContain("0 held");
  });

  it("names rejected files with their reason when filesRejected is non-empty", () => {
    const counters: ExpectedWorkCounters = {
      filesSeenCount: 3,
      filesRejected: [
        { filename: "README.md", reason: "bad-filename" },
        { filename: "not-a-ulid.md", reason: "bad-filename" },
      ],
      refsHeld: [],
    };
    const output = renderExpectedWorkCounters(counters);
    expect(output).toContain("3 file(s) seen");
    expect(output).toContain("2 rejected");
    expect(output).toContain("README.md (bad-filename)");
    expect(output).toContain("not-a-ulid.md (bad-filename)");
  });

  it("names held refs with their reason when refsHeld is non-empty", () => {
    const counters: ExpectedWorkCounters = {
      filesSeenCount: 0,
      filesRejected: [],
      refsHeld: [
        { ref: "native:01AAAAAAAAAAAAAAAAAAAAAAAA", reason: "not-ready" },
        { ref: "native:01BBBBBBBBBBBBBBBBBBBBBBBB", reason: "unmerged-dependency" },
      ],
    };
    const output = renderExpectedWorkCounters(counters);
    expect(output).toContain("2 held");
    expect(output).toContain("native:01AAAAAAAAAAAAAAAAAAAAAAAA (not-ready)");
    expect(output).toContain("native:01BBBBBBBBBBBBBBBBBBBBBBBB (unmerged-dependency)");
  });

  it("renders both rejected files and held refs together", () => {
    const counters: ExpectedWorkCounters = {
      filesSeenCount: 4,
      filesRejected: [{ filename: "bad.txt", reason: "bad-filename" }],
      refsHeld: [{ ref: "native:01CCCCCCCCCCCCCCCCCCCCCCCC", reason: "pending-overlap" }],
    };
    const output = renderExpectedWorkCounters(counters);
    expect(output).toContain("4 file(s) seen");
    expect(output).toContain("1 rejected");
    expect(output).toContain("1 held");
    expect(output).toContain("bad.txt (bad-filename)");
    expect(output).toContain("native:01CCCCCCCCCCCCCCCCCCCCCCCC (pending-overlap)");
  });

  it("is deterministic — same input always produces the same output", () => {
    const counters: ExpectedWorkCounters = {
      filesSeenCount: 2,
      filesRejected: [{ filename: "foo.md", reason: "bad-filename" }],
      refsHeld: [{ ref: "native:01DDDDDDDDDDDDDDDDDDDDDDDD", reason: "deps-not-done" }],
    };
    const first = renderExpectedWorkCounters(counters);
    const second = renderExpectedWorkCounters(counters);
    expect(first).toBe(second);
  });
});
