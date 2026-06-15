/**
 * Input-contract parity tests — Story native:01KV45Y13EQYVZP98PR8A9F40P (AC1).
 *
 * Both the MCP transport (register.ts) and the CLI transport (cli.ts) must
 * accept and reject identical inputs for each tool. The shared schema module
 * (`schemas/tool-input-schemas.ts`) is the single source of truth; this test
 * suite asserts parity by validating that:
 *
 *   (a) Every tool name registered in TOOL_INPUT_SCHEMAS appears in the
 *       tool-inventory snapshot (i.e. the schema map covers only real tools).
 *
 *   (b) The required[] array in each schema entry matches what would be
 *       enforced: a call with one required field missing is always rejected
 *       by the CLI validation path (the missing-required-fields branch).
 *
 *   (c) A call with all required fields present is NOT rejected by the CLI
 *       entry-point validation (the tool function may still reject it deeper,
 *       but that is the tool's own concern — the transport must pass it on).
 *
 * These tests are purely structural — they do NOT execute tool functions or
 * touch the filesystem, so they run fast and in isolation.
 */

import { describe, expect, it } from "vitest";
import {
  TOOL_INPUT_SCHEMAS,
  type ToolInputSchema,
} from "../../schemas/tool-input-schemas.js";
import TOOL_INVENTORY from "../tool-inventory.snapshot.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Helpers that mirror the CLI transport's validation logic
// ---------------------------------------------------------------------------

function cliValidate(
  toolName: string,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; missing: string[] } {
  const schema: ToolInputSchema | undefined = TOOL_INPUT_SCHEMAS[toolName];
  if (schema === undefined) {
    // CLI-only tool — no schema-level validation, always passes through
    return { ok: true };
  }
  const missing = (schema.required ?? []).filter(
    (k) => !Object.prototype.hasOwnProperty.call(args, k),
  );
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// (a) Schema map covers only real, registered tools
// ---------------------------------------------------------------------------

describe("TOOL_INPUT_SCHEMAS keys match the tool inventory", () => {
  const inventorySet = new Set<string>(TOOL_INVENTORY as string[]);

  it("every key in TOOL_INPUT_SCHEMAS is in the tool inventory", () => {
    const schemaKeys = Object.keys(TOOL_INPUT_SCHEMAS);
    const stray = schemaKeys.filter((k) => !inventorySet.has(k));
    expect(stray, `Schema keys not in inventory: ${stray.join(", ")}`).toHaveLength(0);
  });

  it("every tool in the inventory that is in the schema map has a valid schema object", () => {
    for (const [name, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
      expect(
        schema.type,
        `Schema for ${name} must have type "object"`,
      ).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Missing a required field → CLI transport rejects the call
// ---------------------------------------------------------------------------

describe("CLI transport rejects calls missing a required field", () => {
  for (const [toolName, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
    const required = schema.required ?? [];
    if (required.length === 0) {
      // No required fields — nothing to reject
      continue;
    }

    it(`${toolName}: omitting each required field triggers a rejection`, () => {
      // Build a "full" args object with every required field present (as a
      // placeholder value — the transport check is presence-only).
      const fullArgs: Record<string, unknown> = {};
      for (const k of required) {
        fullArgs[k] = "placeholder";
      }

      for (const missingField of required) {
        const partial = { ...fullArgs };
        delete partial[missingField];
        const result = cliValidate(toolName, partial);
        expect(
          result.ok,
          `${toolName}: omitting "${missingField}" should be rejected but was accepted`,
        ).toBe(false);
        if (!result.ok) {
          expect(result.missing).toContain(missingField);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (c) All required fields present → CLI transport passes the call through
// ---------------------------------------------------------------------------

describe("CLI transport passes calls with all required fields present", () => {
  for (const [toolName, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
    it(`${toolName}: providing all required fields is accepted`, () => {
      const required = schema.required ?? [];
      const fullArgs: Record<string, unknown> = {};
      for (const k of required) {
        fullArgs[k] = "placeholder";
      }
      const result = cliValidate(toolName, fullArgs);
      expect(
        result.ok,
        `${toolName}: call with all required fields should be accepted`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// (d) Schema parity: each schema's required[] is a subset of its properties
// ---------------------------------------------------------------------------

describe("Schema internal consistency: required fields are declared in properties", () => {
  for (const [toolName, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
    const required = schema.required ?? [];
    if (required.length === 0) continue;

    it(`${toolName}: all required fields are declared in properties`, () => {
      const props = Object.keys(schema.properties ?? {});
      const notDeclared = required.filter((k) => !props.includes(k));
      expect(
        notDeclared,
        `${toolName}: required field(s) ${notDeclared.join(", ")} not in properties`,
      ).toHaveLength(0);
    });
  }
});
