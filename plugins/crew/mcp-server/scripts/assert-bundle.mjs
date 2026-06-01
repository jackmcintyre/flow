#!/usr/bin/env node
// @ts-check
/**
 * Fast static guard on the esbuild bundles (companion to assert-clean-install).
 *
 * esbuild emits a `__require` helper of the form
 *     typeof require !== "undefined" ? require : (x) => { throw "Dynamic require of …" }
 * so that CJS deps doing `require("fs")` keep working. Under ESM there is no
 * ambient `require`, so scripts/bundle.mjs injects a createRequire banner that
 * binds one — which makes esbuild's helper take the real-`require` branch and the
 * throwing branch become dead code. (Proven at runtime by assert-clean-install.)
 *
 * The invariant this enforces: if a bundle contains esbuild's throwing-require
 * shim, it MUST also contain the createRequire(import.meta.url) banner that
 * neutralises it. A bundle with the shim but no banner WOULD throw
 * `Dynamic require of "fs"` on a clean install — exactly the regression this
 * whole change exists to prevent.
 *
 * Invoked by `pnpm build` after `bundle`. Exits 1 with a report on violation.
 * Usage: node scripts/assert-bundle.mjs <file> [<file>...]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const THROWING_SHIM = /Dynamic require of/;
// Stable marker emitted by scripts/bundle.mjs's createRequire banner. Matching a
// marker rather than the call site keeps the check robust to alias renaming.
const CREATE_REQUIRE_BANNER = /crew:require-banner/;

/**
 * @param {string} filePath
 * @returns {{ clean: boolean; violations: string[] }}
 */
export function assertBundleClean(filePath) {
  if (!existsSync(filePath)) {
    return { clean: false, violations: [`File not found: ${filePath}`] };
  }
  const content = readFileSync(filePath, "utf-8");
  const violations = [];
  if (THROWING_SHIM.test(content) && !CREATE_REQUIRE_BANNER.test(content)) {
    violations.push(
      "esbuild's throwing __require shim is present but the createRequire(import.meta.url) banner is missing — dynamic requires of node builtins will throw on a clean install. Restore the banner in scripts/bundle.mjs.",
    );
  }
  return { clean: violations.length === 0, violations };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error(
      "assert-bundle: no bundle paths provided.\nUsage: node scripts/assert-bundle.mjs <file> [<file>...]",
    );
    process.exit(2);
  }
  let failed = false;
  for (const f of files) {
    const { clean, violations } = assertBundleClean(resolve(f));
    if (clean) {
      console.log(`assert-bundle: OK  ${f}`);
    } else {
      failed = true;
      console.error(`assert-bundle: FAIL ${f}`);
      for (const v of violations) console.error(`  - ${v}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

// Run only when invoked directly, not when imported. pathToFileURL keeps the
// entry-point comparison OS-agnostic.
const isDirectInvocation =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  main();
}
