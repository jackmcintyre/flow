import { mkdir, access, readFile } from "node:fs/promises";
import * as path from "node:path";
import { writeManagedFile } from "../lib/managed-fs.js";

/**
 * `initWorkspace` — first-run scaffolder for the `/flow:init` skill.
 *
 * Turns a bare directory into a Flow workspace deterministically and
 * idempotently. The load-bearing act is writing an explicit
 * `.flow/config.yaml`: on a fresh repo no adapter can auto-detect (native
 * detection needs an existing story, BMad needs a stories root), so without an
 * explicit config the workspace resolver dead-ends with NoAdapterMatchedError.
 * Writing the config up front breaks that deadlock so `/flow:plan`, `/flow:run`,
 * etc. work immediately.
 *
 * Idempotent by construction: every artefact is created only when absent and
 * reported under `skipped` otherwise. It NEVER overwrites an existing
 * `.flow/config.yaml`, `docs/standards.md`, or any state — re-running is safe.
 *
 * All file writes route through `writeManagedFile` (the sanctioned write seam —
 * `docs/standards.md` is a canonical path and requires the MCP tool context).
 * Empty state directories are created with `mkdir` (a non-write-shaped fs API).
 * `git init` is the caller's (skill's) responsibility — a coarse prerequisite,
 * not a behaviour-gating artefact.
 */

const SUPPORTED_ADAPTERS = ["native", "bmad"] as const;
type InitAdapter = (typeof SUPPORTED_ADAPTERS)[number];

const STATE_DIRS = ["to-do", "in-progress", "blocked", "done"] as const;

export interface InitWorkspaceArgs {
  /** Absolute path to the repo being initialised. */
  targetRepoRoot: string;
  /** Adapter to declare in the config. Defaults to `native`. */
  adapter?: InitAdapter;
  /** Plugin root (for resolving the shipped `docs/standards-example.md`). */
  pluginRoot: string;
  /** MCP tool context, required to write the canonical `docs/standards.md`. */
  mcpToolContext: { toolName: string; role: string };
}

export interface InitWorkspaceResult {
  adapter: InitAdapter;
  created: string[];
  skipped: string[];
  gitPresent: boolean;
  teamPresent: boolean;
  configPath: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function initWorkspace(
  args: InitWorkspaceArgs,
): Promise<InitWorkspaceResult> {
  const adapter: InitAdapter = args.adapter ?? "native";
  const root = args.targetRepoRoot;
  const created: string[] = [];
  const skipped: string[] = [];

  const flowDir = path.join(root, ".flow");
  const configPath = path.join(flowDir, "config.yaml");

  // 1. .flow/config.yaml — the load-bearing artefact. An explicit adapter
  //    declaration is what makes a story-less fresh repo resolvable. Not a
  //    canonical-state path, so no MCP context is required for this write.
  if (await pathExists(configPath)) {
    skipped.push(".flow/config.yaml");
  } else {
    await writeManagedFile({
      absPath: configPath,
      contents: `adapter: ${adapter}\nadapter_config: {}\n`,
      targetRepoRoot: root,
      mcpToolContext: args.mcpToolContext,
    });
    created.push(".flow/config.yaml");
  }

  // 2. .flow/state/{to-do,in-progress,blocked,done}/ — the manifest lanes the
  //    run loop and review worktrees expect to exist. Empty dirs; the runtime
  //    writes manifests into them. (.flow is gitignored in a target repo, so no
  //    .gitkeep is needed to track them.)
  for (const sub of STATE_DIRS) {
    const dir = path.join(flowDir, "state", sub);
    if (await pathExists(dir)) {
      skipped.push(`.flow/state/${sub}/`);
    } else {
      await mkdir(dir, { recursive: true });
      created.push(`.flow/state/${sub}/`);
    }
  }

  // 3. .flow/native-stories/ — the native source-story home (native only).
  if (adapter === "native") {
    const nativeStories = path.join(flowDir, "native-stories");
    if (await pathExists(nativeStories)) {
      skipped.push(".flow/native-stories/");
    } else {
      await mkdir(nativeStories, { recursive: true });
      created.push(".flow/native-stories/");
    }
  }

  // 4. docs/standards.md — every reviewer verdict reads it. Seed from the
  //    shipped template; never clobber an existing standard. This is a
  //    canonical path, so the write carries the MCP tool context.
  const standardsTarget = path.join(root, "docs", "standards.md");
  if (await pathExists(standardsTarget)) {
    skipped.push("docs/standards.md");
  } else {
    const template = await readFile(
      path.join(args.pluginRoot, "docs", "standards-example.md"),
      "utf8",
    );
    await writeManagedFile({
      absPath: standardsTarget,
      contents: template,
      targetRepoRoot: root,
      mcpToolContext: args.mcpToolContext,
    });
    created.push("docs/standards.md");
  }

  return {
    adapter,
    created,
    skipped,
    gitPresent: await pathExists(path.join(root, ".git")),
    teamPresent: await pathExists(path.join(root, "team")),
    configPath,
  };
}

/**
 * Render the scaffold result plus a fixed how-it-works orientation and the
 * recommended next step. This is the operator-facing output of `/flow:init`.
 */
export function renderInitWorkspace(result: InitWorkspaceResult): string {
  const lines: string[] = [];

  lines.push(
    result.created.length > 0
      ? `Flow workspace initialised (adapter: ${result.adapter}).`
      : `Flow workspace already initialised (adapter: ${result.adapter}).`,
  );
  lines.push("");

  if (result.created.length > 0) {
    lines.push("Created:");
    for (const item of result.created) lines.push(`  + ${item}`);
    lines.push("");
  }
  if (result.skipped.length > 0) {
    lines.push(`Already present (left as-is): ${result.skipped.join(", ")}`);
    lines.push("");
  }

  lines.push("How flow works");
  lines.push(
    "  flow drives a backlog of stories through an AI engineering team.",
  );
  lines.push("  You keep the backlog good; the team ships it.");
  lines.push("");
  lines.push(
    "  1. /flow:hire    stand up your team (or /flow:hire default for the standard roster)",
  );
  lines.push(
    "  2. /flow:plan    plan stories (or /flow:plan <feature> to draft one)",
  );
  lines.push("  3. /flow:ready   grade a story and admit it to the run");
  lines.push(
    "  4. /flow:run     the team builds, reviews, and merges each admitted story",
  );
  lines.push("  5. /flow:retro   capture lessons and sharpen the team");
  lines.push("");
  lines.push(
    "  /flow:dashboard shows status at any time; /flow:help suggests your next move.",
  );
  lines.push("");

  lines.push(
    result.teamPresent
      ? "Next: /flow:plan <feature> to draft your first story, then /flow:ready <ref>."
      : "Next: /flow:hire default to stand up your team, then /flow:plan <feature>.",
  );

  if (!result.gitPresent) {
    lines.push("");
    lines.push(
      "Note: this directory is not a git repo yet — run `git init` before /flow:run (the run loop needs git).",
    );
  }

  return lines.join("\n");
}
