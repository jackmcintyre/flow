/**
 * Unit tests for `parseYield` — Story 4.11 Task 1.6.
 *
 * Covers AC6 sub-case (6k): parser unit tests.
 * All tests are pure (no IO).
 */

import { describe, expect, it } from "vitest";
import { parseYield, YIELD_PHRASE_TEMPLATE, YIELD_PHRASE_REGEX } from "../yield-parser.js";

const DOMAIN = "authentication authorization and secret handling";
const YIELD_PHRASE = `This sits in ${DOMAIN}'s domain — handing off.`;

// ---------------------------------------------------------------------------
// (i) Verbatim match returns { ok: true, domain: "<value>" }
// ---------------------------------------------------------------------------

describe("parseYield — happy path", () => {
  it("exact yield phrase on last non-empty line → { ok: true, domain }", () => {
    const transcript = `Some reviewer prose.\n\n${YIELD_PHRASE}`;
    expect(parseYield(transcript)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("phrase is the only line → { ok: true, domain }", () => {
    expect(parseYield(YIELD_PHRASE)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("trailing newlines after the phrase are tolerated (last non-empty line still matches)", () => {
    const transcript = `${YIELD_PHRASE}\n\n   \n`;
    expect(parseYield(transcript)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("multi-line transcript ending with exact phrase → { ok: true, domain }", () => {
    const transcript = [
      "Some reviewer output.",
      "Looking at the PR diff.",
      "This has auth concerns.",
      YIELD_PHRASE,
    ].join("\n");
    expect(parseYield(transcript)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("domain with spaces is captured verbatim", () => {
    const domainWithSpaces = "test design and coverage gaps";
    const phrase = `This sits in ${domainWithSpaces}'s domain — handing off.`;
    expect(parseYield(phrase)).toEqual({ ok: true, domain: domainWithSpaces });
  });
});

// ---------------------------------------------------------------------------
// (viii) Trailing whitespace on the yield-line is trimmed before matching
// ---------------------------------------------------------------------------

describe("parseYield — trailing whitespace trimming", () => {
  it("trailing whitespace on the yield line is trimmed before matching", () => {
    const transcript = `${YIELD_PHRASE}   `;
    expect(parseYield(transcript)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("trailing whitespace + trailing newlines are both tolerated", () => {
    const transcript = `${YIELD_PHRASE}  \n\n`;
    expect(parseYield(transcript)).toEqual({ ok: true, domain: DOMAIN });
  });
});

// ---------------------------------------------------------------------------
// (ii) En-dash returns drift
// ---------------------------------------------------------------------------

describe("parseYield — en-dash returns drift", () => {
  it("en-dash (U+2013) instead of em-dash → drift", () => {
    // NOTE: the transcript contains "sits in" so discriminator = drift
    const drift = `This sits in ${DOMAIN}'s domain – handing off.`;
    expect(parseYield(drift)).toEqual({ ok: false, reason: "drift" });
  });

  it("hyphen instead of em-dash → drift", () => {
    const drift = `This sits in ${DOMAIN}'s domain - handing off.`;
    expect(parseYield(drift)).toEqual({ ok: false, reason: "drift" });
  });
});

// ---------------------------------------------------------------------------
// (iii) Missing trailing period returns drift
// ---------------------------------------------------------------------------

describe("parseYield — missing trailing period returns drift", () => {
  it("phrase without trailing period → drift", () => {
    const drift = `This sits in ${DOMAIN}'s domain — handing off`;
    expect(parseYield(drift)).toEqual({ ok: false, reason: "drift" });
  });

  it("phrase with exclamation mark instead of period → drift", () => {
    const drift = `This sits in ${DOMAIN}'s domain — handing off!`;
    expect(parseYield(drift)).toEqual({ ok: false, reason: "drift" });
  });
});

// ---------------------------------------------------------------------------
// (iv) Lowercase `t` returns drift (case-sensitive; contains `sits in`)
// ---------------------------------------------------------------------------

describe("parseYield — case sensitivity", () => {
  it("lowercase first word `this` → drift (contains `sits in`)", () => {
    // lowercase `t` → doesn't match regex; but contains `sits in` → drift
    const drift = `this sits in ${DOMAIN}'s domain — handing off.`;
    expect(parseYield(drift)).toEqual({ ok: false, reason: "drift" });
  });
});

// ---------------------------------------------------------------------------
// (v) Empty string returns empty
// ---------------------------------------------------------------------------

describe("parseYield — empty transcript", () => {
  it("empty string → { ok: false, reason: 'empty' }", () => {
    expect(parseYield("")).toEqual({ ok: false, reason: "empty" });
  });
});

// ---------------------------------------------------------------------------
// (vi) Whitespace-only returns empty
// ---------------------------------------------------------------------------

describe("parseYield — whitespace-only transcript", () => {
  it("only newlines → { ok: false, reason: 'empty' }", () => {
    expect(parseYield("\n\n\n")).toEqual({ ok: false, reason: "empty" });
  });

  it("only spaces → { ok: false, reason: 'empty' }", () => {
    expect(parseYield("   \n   ")).toEqual({ ok: false, reason: "empty" });
  });
});

// ---------------------------------------------------------------------------
// (vii) Yield phrase mid-transcript with different last line → no-yield
//       (the last line lacks `sits in`)
// ---------------------------------------------------------------------------

describe("parseYield — last-line semantics", () => {
  it("yield phrase mid-transcript but different last line (no `sits in`) → no-yield", () => {
    const transcript = [
      "Starting review.",
      YIELD_PHRASE,
      "**Verdict: READY FOR MERGE**",
    ].join("\n");
    expect(parseYield(transcript)).toEqual({ ok: false, reason: "no-yield" });
  });

  it("yield phrase mid-transcript, last line has `sits in` → drift", () => {
    const transcript = [
      YIELD_PHRASE,
      "This sits in the middle of my analysis.",
    ].join("\n");
    expect(parseYield(transcript)).toEqual({ ok: false, reason: "drift" });
  });
});

// ---------------------------------------------------------------------------
// YIELD_PHRASE_TEMPLATE and YIELD_PHRASE_REGEX exports
// ---------------------------------------------------------------------------

describe("YIELD_PHRASE_TEMPLATE", () => {
  it("template contains the <domain> placeholder token", () => {
    expect(YIELD_PHRASE_TEMPLATE).toContain("<domain>");
  });

  it("template does NOT contain the old <role> placeholder", () => {
    expect(YIELD_PHRASE_TEMPLATE).not.toContain("<role>");
  });

  it("template includes em-dash and trailing period", () => {
    expect(YIELD_PHRASE_TEMPLATE).toContain("—");
    expect(YIELD_PHRASE_TEMPLATE.endsWith(".")).toBe(true);
  });
});

describe("YIELD_PHRASE_REGEX", () => {
  it("regex matches the exact yield phrase and captures domain in group 1", () => {
    const m = YIELD_PHRASE_REGEX.exec(YIELD_PHRASE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(DOMAIN);
  });

  it("regex does not match phrase with en-dash", () => {
    const phrase = `This sits in ${DOMAIN}'s domain – handing off.`;
    expect(YIELD_PHRASE_REGEX.exec(phrase)).toBeNull();
  });

  it("regex does not match phrase without trailing period", () => {
    const phrase = `This sits in ${DOMAIN}'s domain — handing off`;
    expect(YIELD_PHRASE_REGEX.exec(phrase)).toBeNull();
  });
});
