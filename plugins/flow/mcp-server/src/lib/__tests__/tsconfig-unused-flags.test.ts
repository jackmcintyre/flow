/**
 * Verifies that the TypeScript config catches unused locals/parameters and
 * that intentionally-unused parameters prefixed with _ are exempt.
 *
 * AC1: noUnusedLocals and noUnusedParameters are enabled in tsconfig.base.json.
 * AC3: Underscore-prefixed parameters do not produce a compiler error.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSCONFIG_BASE = path.resolve(HERE, "..", "..", "..", "..", "tsconfig.base.json");
const TSCONFIG_MCP = path.resolve(HERE, "..", "..", "..", "tsconfig.json");
const TSC_BIN = path.resolve(HERE, "..", "..", "..", "node_modules", ".bin", "tsc");

describe("tsconfig — noUnusedLocals and noUnusedParameters", () => {
  it("tsconfig.base.json enables noUnusedLocals", () => {
    const config = JSON.parse(readFileSync(TSCONFIG_BASE, "utf8")) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(config.compilerOptions?.noUnusedLocals).toBe(true);
  });

  it("tsconfig.base.json enables noUnusedParameters", () => {
    const config = JSON.parse(readFileSync(TSCONFIG_BASE, "utf8")) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(config.compilerOptions?.noUnusedParameters).toBe(true);
  });

  it("underscore-prefixed parameters do not produce a compiler error (tsc --noEmit exits 0)", () => {
    // Run tsc --noEmit against the mcp-server tsconfig (which extends tsconfig.base.json
    // and therefore has noUnusedLocals + noUnusedParameters enabled). A non-zero exit
    // would mean underscore-prefixed params in the codebase are triggering TS6133/TS6196.
    expect(() => {
      execSync(`"${TSC_BIN}" -p "${TSCONFIG_MCP}" --noEmit`, { stdio: "pipe" });
    }).not.toThrow();
  });
});
