#!/usr/bin/env node
// @ts-check
/**
 * Clean-install self-containment proof — the ground-truth guard.
 *
 * Copies the plugin tree to a temp dir WITHOUT node_modules (exactly what a
 * GitHub-marketplace or clean-machine install ships), then boots the bundled MCP
 * server and drives a real tool call over stdio. If the bundle still needs a
 * third-party dependency, this fails with `ERR_MODULE_NOT_FOUND` — catching the
 * regression that a static scan can't (e.g. an un-inlined transitive dep, or a
 * lazily-required module). Stronger than assert-bundle; the two run together.
 *
 * Invoked by `pnpm build` after assert-bundle, so the guarantee holds locally and
 * in CI. Self-cleans its temp dir. Exits 1 on failure.
 *
 * Asserts: the server boots (emits serverInfo), answers a `tools/call`
 * (`getStatus`) with a response carrying the request id, and prints no
 * module-resolution error anywhere on stdio.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const MCP_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.resolve(MCP_SERVER, ".."); // plugins/flow
// A target for getStatus. The flow repo root is two up from the plugin root; its
// .flow/ is gitignored, so getStatus may return a typed adapter error in a fresh
// checkout — that is fine. We only assert the tool RAN from the bundle (no
// missing-module crash), not its verdict.
const TARGET = path.resolve(PLUGIN_ROOT, "..", "..");

const MODULE_ERROR = /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/;

const work = await mkdtemp(path.join(tmpdir(), "flow-clean-install-"));
try {
  const dest = path.join(work, "flow");
  await cp(PLUGIN_ROOT, dest, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("node_modules"),
  });

  const entry = path.join(dest, "mcp-server", "dist", "index.js");
  const requests =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "clean-install-guard", version: "0" },
      },
    }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n" +
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "getStatus", arguments: { targetRepoRoot: TARGET } },
    }) +
    "\n";

  const out = await driveServer(entry, requests);

  /** @type {string[]} */
  const failures = [];
  if (MODULE_ERROR.test(out)) {
    failures.push("bundle requires a dependency absent on a clean install (module-resolution error)");
  }
  if (!/"serverInfo"/.test(out)) failures.push("server did not boot (no serverInfo in initialize response)");
  if (!/"id":\s*2/.test(out)) failures.push("server did not answer the tools/call (no id:2 response)");

  if (failures.length > 0) {
    console.error("assert-clean-install: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    console.error("--- server output (first 2000 chars) ---");
    console.error(out.slice(0, 2000));
    process.exit(1);
  }
  console.log("assert-clean-install: OK — bundled server boots + serves a tool call with no node_modules");
} finally {
  await rm(work, { recursive: true, force: true });
}

/**
 * Spawn the server, feed requests, keep stdin OPEN until the id:2 response lands
 * (closing stdin makes the server exit before async handlers finish), then kill.
 * @param {string} entry
 * @param {string} input
 * @returns {Promise<string>}
 */
function driveServer(entry, input) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const done = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolvePromise(out);
    };
    const timer = setTimeout(done, 20000);
    const onData = (/** @type {Buffer} */ d) => {
      out += d.toString();
      if (/"id":\s*2/.test(out) || MODULE_ERROR.test(out)) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => {
      clearTimeout(timer);
      done();
    });
    child.stdin.write(input);
    // Intentionally do NOT end stdin — the transport treats stdin close as a
    // shutdown signal and exits before the async tool handler resolves.
  });
}
