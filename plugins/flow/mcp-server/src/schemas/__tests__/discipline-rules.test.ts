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

import { describe, expect, it } from "vitest";
import {
  DisciplineRuleSchema,
  DisciplineRulesFileSchema,
  parseRuleRegistry,
  serializeRuleRegistry,
  appendRuleNode,
} from "../discipline-rules.js";
import { RuleRegistryMalformedError } from "../../errors.js";

const ULID = "01HZRETR0000000000000000A1";
const ULID_B = "01HZRETR0000000000000000B2";

// Guard: fixture ULIDs must satisfy the schema regex.
if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ULID)) {
  throw new Error(`ULID fixture malformed: ${ULID}`);
}

// A registry carrying a leading comment, an inline comment, and a comment
// attached to a rule. The exact bytes matter for the round-trip assertion.
const COMMENTED_REGISTRY = `# Discipline rules — human-authored ground truth.
# Each rule earns its slot; do not delete without a retirement proposal.
rules:
  # This rule fires on handoff-grammar drift.
  - id: ${ULID}
    text: Dev MUST emit the handoff phrase verbatim. # load-bearing
    target_failure_class: handoff-grammar
    introduced_at: 2026-05-20T10:00:00.000Z
    level: must
`;

// ---------------------------------------------------------------------------
// Comment-preserving round-trip (AC1)
// ---------------------------------------------------------------------------

describe("parseRuleRegistry — comment-preserving round-trip (AC1)", () => {
  it("rewrites a commented registry with no logical change, preserving comments byte-for-byte", () => {
    const { doc, data } = parseRuleRegistry(COMMENTED_REGISTRY);

    // Sanity: parsed shape is what we seeded.
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0]!.id).toBe(ULID);
    expect(data.rules[0]!.target_failure_class).toBe("handoff-grammar");
    expect(data.rules[0]!.level).toBe("must");

    // Round-trip with NO logical mutation → byte-identical (comments survive).
    const rewritten = serializeRuleRegistry(doc);
    expect(rewritten).toBe(COMMENTED_REGISTRY);

    // Every human-authored comment string is present in the rewrite.
    expect(rewritten).toContain(
      "# Discipline rules — human-authored ground truth.",
    );
    expect(rewritten).toContain(
      "# Each rule earns its slot; do not delete without a retirement proposal.",
    );
    expect(rewritten).toContain("# This rule fires on handoff-grammar drift.");
    expect(rewritten).toContain("# load-bearing");
  });

  it("preserves leading + inline comments across an append (existing region untouched)", () => {
    const { doc } = parseRuleRegistry(COMMENTED_REGISTRY);
    appendRuleNode(doc, {
      id: ULID_B,
      text: "Reviewer MUST verify every AC.",
      target_failure_class: "rubber-stamp",
      introduced_at: "2026-05-31T10:00:00.000Z",
      level: "should",
    });
    const rewritten = serializeRuleRegistry(doc);

    // Existing comments survive the append.
    expect(rewritten).toContain(
      "# Discipline rules — human-authored ground truth.",
    );
    expect(rewritten).toContain("# This rule fires on handoff-grammar drift.");
    expect(rewritten).toContain("# load-bearing");

    // New rule is present; the original rule untouched.
    const reparsed = parseRuleRegistry(rewritten);
    expect(reparsed.data.rules).toHaveLength(2);
    expect(reparsed.data.rules[0]!.id).toBe(ULID);
    expect(reparsed.data.rules[1]!.id).toBe(ULID_B);
    expect(reparsed.data.rules[1]!.target_failure_class).toBe("rubber-stamp");
  });
});

// ---------------------------------------------------------------------------
// Absent registry → empty-but-valid (AC1)
// ---------------------------------------------------------------------------

describe("parseRuleRegistry — absent file (AC1)", () => {
  it("parses null (absent file) to an empty-but-valid registry, never an error", () => {
    const { data, doc } = parseRuleRegistry(null);
    expect(data.rules).toEqual([]);
    // The empty doc has a `rules` sequence ready for the first append.
    appendRuleNode(doc, {
      id: ULID,
      text: "first rule",
      target_failure_class: "fc",
      introduced_at: "2026-05-31T10:00:00.000Z",
    });
    const reparsed = parseRuleRegistry(serializeRuleRegistry(doc));
    expect(reparsed.data.rules).toHaveLength(1);
  });

  it("parses an empty `rules: []` file to an empty registry", () => {
    const { data } = parseRuleRegistry("rules: []\n");
    expect(data.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Malformed registry → typed error (AC1)
// ---------------------------------------------------------------------------

describe("parseRuleRegistry — malformed file (AC1)", () => {
  it("raises RuleRegistryMalformedError when a rule is missing a required field", () => {
    const malformed = `rules:
  - id: ${ULID}
    text: missing target_failure_class and introduced_at
`;
    let thrown: unknown;
    try {
      parseRuleRegistry(malformed);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RuleRegistryMalformedError);
    const e = thrown as RuleRegistryMalformedError;
    // The Zod path names the offending rule region.
    expect(e.yamlPath).toContain("rules");
    expect(typeof e.zodMessage).toBe("string");
    expect(e.zodMessage.length).toBeGreaterThan(0);
  });

  it("raises RuleRegistryMalformedError on an unknown key (strict mode)", () => {
    const malformed = `rules:
  - id: ${ULID}
    text: t
    target_failure_class: fc
    introduced_at: 2026-05-31T10:00:00.000Z
    surprise_key: nope
`;
    expect(() => parseRuleRegistry(malformed)).toThrow(
      RuleRegistryMalformedError,
    );
  });

  it("raises RuleRegistryMalformedError on YAML syntax errors", () => {
    expect(() => parseRuleRegistry("rules:\n  - id: [unterminated\n")).toThrow(
      RuleRegistryMalformedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Rule schema shape
// ---------------------------------------------------------------------------

describe("DisciplineRuleSchema", () => {
  it("accepts a complete rule (with optional level)", () => {
    const r = DisciplineRuleSchema.parse({
      id: ULID,
      text: "t",
      target_failure_class: "fc",
      introduced_at: "2026-05-31T10:00:00.000Z",
      level: "advisory",
    });
    expect(r.level).toBe("advisory");
  });

  it("accepts a rule without the optional level", () => {
    const r = DisciplineRuleSchema.parse({
      id: ULID,
      text: "t",
      target_failure_class: "fc",
      introduced_at: "2026-05-31T10:00:00.000Z",
    });
    expect(r.level).toBeUndefined();
  });

  it("rejects a non-ULID id", () => {
    expect(() =>
      DisciplineRuleSchema.parse({
        id: "not-a-ulid",
        text: "t",
        target_failure_class: "fc",
        introduced_at: "2026-05-31T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an out-of-enum level", () => {
    expect(() =>
      DisciplineRuleSchema.parse({
        id: ULID,
        text: "t",
        target_failure_class: "fc",
        introduced_at: "2026-05-31T10:00:00.000Z",
        level: "critical",
      }),
    ).toThrow();
  });

  it("rejects empty text / target_failure_class", () => {
    expect(() =>
      DisciplineRuleSchema.parse({
        id: ULID,
        text: "",
        target_failure_class: "fc",
        introduced_at: "2026-05-31T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("is strict — rejects unknown keys", () => {
    expect(() =>
      DisciplineRuleSchema.parse({
        id: ULID,
        text: "t",
        target_failure_class: "fc",
        introduced_at: "2026-05-31T10:00:00.000Z",
        extra: 1,
      }),
    ).toThrow();
  });

  it("file schema accepts an empty rules array and is strict on the wrapper", () => {
    expect(DisciplineRulesFileSchema.parse({ rules: [] }).rules).toEqual([]);
    expect(() =>
      DisciplineRulesFileSchema.parse({ rules: [], extra: 1 }),
    ).toThrow();
  });
});
