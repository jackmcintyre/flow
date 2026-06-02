#!/usr/bin/env node
// @ts-check
/**
 * Story 5.24 — post-build deterministic `.d.ts` normaliser.
 *
 * Why this exists
 * ---------------
 * `tsc` emits Zod-inferred enum types as `z.ZodEnum<{ k1: "v1"; k2: "v2"; ... }>`
 * blocks. Zod v4's internal type-shape for `z.enum([...])` produces an object-literal
 * type whose key order is NOT the source-array order — it's the order Zod's runtime
 * happens to enumerate the entries, which is sensitive to module-load order and
 * cache state across `pnpm install` regenerations.
 *
 * Result: across machines or even consecutive cold installs on the same machine,
 * `dist/*.d.ts` files swap key ordering inside `ZodEnum<{...}>` blocks while staying
 * semantically identical. The committed `dist/` keeps drifting versus fresh builds,
 * tripping the working-tree-clean invariant the dogfood checklist depends on.
 *
 * Fix
 * ---
 * Walk every emitted `.d.ts` file, find `ZodEnum<{ ... }>` blocks, sort their
 * `<key>: <literal>;` members alphabetically by key. Idempotent — running twice
 * produces the same output. Touches nothing outside `ZodEnum<{...}>` blocks, so
 * other type structure (interfaces, function signatures, object schemas where key
 * order is semantically meaningful) is preserved byte-for-byte.
 *
 * Wired into `pnpm build` after `tsc`. See AC2 in story 5.24.
 */
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_ROOT = path.resolve(__dirname, "..", "dist");

/**
 * Walk a directory recursively and yield absolute paths of files matching `predicate`.
 * @param {string} root
 * @param {(p: string) => boolean} predicate
 * @returns {Promise<string[]>}
 */
async function listFiles(root, predicate) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Normalise all `z.ZodEnum<{ ... }>` and `ZodEnum<{ ... }>` blocks in a `.d.ts` source string
 * by sorting their `<key>: <literal>;` members alphabetically by key.
 *
 * The block grammar we accept (matches what tsc + Zod v4 emit):
 *
 *   ZodEnum<{
 *     <indent><key>: <stringLiteral>;
 *     <indent><key>: <stringLiteral>;
 *     ...
 *   }>
 *
 * Keys may be bare identifiers or quoted strings. Values are always string literals.
 * If a block doesn't match this shape (e.g. nested generics, comments inside), we leave
 * it untouched — safer to under-normalise than corrupt the file.
 *
 * @param {string} source
 * @returns {string}
 */
export function normaliseDts(source) {
  // Match `ZodEnum<{` (optionally prefixed by `z.`) up to the matching `}>`.
  // The body is line-oriented: each member is on its own line as `<indent><key>: <literal>;`.
  // We use a non-greedy match for the body and require the close to be `}>` so we don't
  // accidentally span across an unrelated generic close.
  const blockRe = /(\bZodEnum<\{)([\s\S]*?)(\}>)/g;

  return source.replace(blockRe, (full, open, body, close) => {
    const lines = body.split("\n");
    // Identify the contiguous run of member lines. Tolerate leading/trailing blank lines
    // and preserve them at the boundaries.
    const memberLineRe = /^(\s+)(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\s*("[^"]*"|'[^']*'|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?|true|false|null);\s*$/;

    // Split body into [leading, members[], trailing]. All non-member lines stay in place.
    /** @type {{ indent: string; key: string; raw: string }[]} */
    const members = [];
    /** @type {string[]} */
    const beforeLines = [];
    /** @type {string[]} */
    const afterLines = [];
    let phase = "before"; // before | members | after
    for (const line of lines) {
      const match = line.match(memberLineRe);
      if (match) {
        if (phase === "after") {
          // Non-contiguous member region — bail out, return block unchanged.
          return full;
        }
        phase = "members";
        const indent = match[1];
        const key = match[2] !== undefined ? match[2] : match[3];
        members.push({ indent, key, raw: line });
      } else {
        if (phase === "before") beforeLines.push(line);
        else if (phase === "members") {
          // A non-member line after we've started collecting members signals end-of-block.
          phase = "after";
          afterLines.push(line);
        } else {
          afterLines.push(line);
        }
      }
    }

    if (members.length < 2) {
      // 0 or 1 members — nothing to sort.
      return full;
    }

    // Sort alphabetically by key (locale-independent, case-sensitive).
    const sorted = [...members].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // Already sorted? Bail out for byte-identical idempotency.
    const alreadySorted = sorted.every((m, i) => m.key === members[i].key);
    if (alreadySorted) return full;

    const rebuiltBody = [...beforeLines, ...sorted.map((m) => m.raw), ...afterLines].join("\n");
    return `${open}${rebuiltBody}${close}`;
  });
}

/**
 * Apply `normaliseDts` to every `.d.ts` under `root`. Returns the list of files
 * whose contents changed.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function normaliseDistTree(root) {
  const files = await listFiles(root, (p) => p.endsWith(".d.ts"));
  /** @type {string[]} */
  const changed = [];
  await Promise.all(
    files.map(async (file) => {
      const original = await fs.readFile(file, "utf8");
      const normalised = normaliseDts(original);
      if (normalised !== original) {
        await fs.writeFile(file, normalised);
        changed.push(file);
      }
    }),
  );
  return changed;
}

// Run as a script when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  try {
    await fs.access(DIST_ROOT);
  } catch {
    console.error(`normalise-dist: dist directory not found at ${DIST_ROOT}; run tsc first.`);
    process.exit(1);
  }
  const changed = await normaliseDistTree(DIST_ROOT);
  if (changed.length > 0) {
    console.log(`normalise-dist: rewrote ${changed.length} file(s) for deterministic enum key ordering.`);
  }
}
