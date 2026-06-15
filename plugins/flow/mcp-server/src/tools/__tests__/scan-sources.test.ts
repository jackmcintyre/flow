/**
 * Integration tests for Story 9.1 (AC5) and Story
 * native:01KT49G9B38NZ2QP16GY843KYK (AC3 — scan idempotency after
 * auto-materialise).
 *
 * Story 9.1 AC5: the scan step writes new backlog manifests with `ready`
 * defaulting to `false`, so a just-scanned item is in the backlog but NOT
 * claimable until the operator blesses it.
 *
 * Story native:01KT49G9B38NZ2QP16GY843KYK AC3: a story auto-materialised by
 * `writeNativeStory` appears in `unchangedRefs` (not `createdRefs`) when the
 * operator subsequently runs `/flow:scan` manually — confirming that the
 * idempotency invariant of scanSources is preserved.
 *
 * Fixture pattern mirrors scan-sources-readfile-resilience.test.ts:
 * minimal native-adapter workspace (config.yaml + native story), fresh tmpdir,
 * scanSources() called directly on the workspace root.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { scanSources } from "../scan-sources.js";
import { writeNativeStory } from "../write-native-story.js";
import { claimNextStory, QUEUE_EMPTIED_LINE } from "../claim-next-story.js";

// A valid Crockford Base32 ULID (uppercase, 26 chars, no I/L/O/U).
const STORY_ULID = "01HZDRF000000000000000009A";
const STORY_REF = `native:${STORY_ULID}`;
const SESSION_ULID = "01HZSESSION00000000000099";

function makeStoryBody(): string {
  return [
    `# Just-scanned story`,
    ``,
    `## Narrative`,
    ``,
    `As a user, I want a feature so that I can verify the readiness brake.`,
    ``,
    `## Acceptance Criteria`,
    ``,
    `**AC1 (integration):**`,
    `**Given** the system is running, **When** the user requests it, **Then** it works.`,
    `vitest: src/__tests__/scan-sources.test.ts`,
    ``,
    // Story 10.3 — §3 enriched sections required to pass the Tier-0 scan gate.
    `## Tasks`,
    ``,
    `- Wire up the handler (AC: 1)`,
    ``,
    `## Cited Sources`,
    ``,
    `- src/handler.ts`,
    ``,
    `## Implementation Notes`,
    ``,
    `Wire up the handler.`,
    ``,
    `## Dependencies`,
    ``,
    ``,
  ].join("\n");
}

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scan-sources-ready-"));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("scan-sources Story 9.1 (AC5) — fresh manifests default ready: false", () => {
  it("writes a freshly-scanned manifest as not-ready and the claim entry point does not return it", async () => {
    const root = path.join(scratch, "workspace");
    await fs.mkdir(root);

    const storiesDir = path.join(root, ".flow", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    // The claim path stats these directories — create them so it does not error.
    await fs.mkdir(path.join(root, ".flow", "state", "in-progress"), { recursive: true });
    await fs.mkdir(path.join(root, ".flow", "state", "done"), { recursive: true });

    // Native-adapter config.
    await atomicWriteFile(
      path.join(root, ".flow", "config.yaml"),
      `adapter: native\nadapter_config: {}\n`,
    );

    // Story 10.3 — seed the cited source so the Tier-0 T0-5 resolvability check
    // passes at scan (cited paths must resolve on disk).
    await atomicWriteFile(path.join(root, "src", "handler.ts"), "// seeded\n");

    // Seed a single source story. No pre-existing manifest → scan composes fresh.
    await atomicWriteFile(path.join(storiesDir, `${STORY_ULID}.md`), makeStoryBody());

    const result = await scanSources({ targetRepoRoot: root });
    expect(result.createdRefs).toContain(STORY_REF);

    // (i) The written to-do/ manifest reads not-ready.
    const manifestPath = path.join(root, ".flow", "state", "to-do", `${STORY_REF}.yaml`);
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = yamlParse(raw) as Record<string, unknown>;
    expect(parsed["ready"]).toBe(false);
    // status is unaffected by the brake.
    expect(parsed["status"]).toBe("to-do");

    // (ii) The claim entry point does not return it — fail-closed.
    const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid: SESSION_ULID });
    expect(claim.next).toBe("queue-emptied");
    expect(claim.chatLog).toContain(QUEUE_EMPTIED_LINE);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KT49G9B38NZ2QP16GY843KYK AC3 — scan idempotency after
// auto-materialise: a story already in to-do/ from writeNativeStory's
// auto-scan appears in unchangedRefs (not createdRefs) on a subsequent
// manual /flow:scan — the idempotency invariant of scanSources is preserved.
// ---------------------------------------------------------------------------

describe("scan-sources Story native:01KT49G9B38NZ2QP16GY843KYK AC3 — idempotency after auto-materialise", () => {
  it("a manifest auto-created by writeNativeStory lands in unchangedRefs on a subsequent manual scan (no duplicate, no overwrite)", async () => {
    const workspace = path.join(scratch, "workspace-ac3");
    await fs.mkdir(workspace);

    const storiesDir = path.join(workspace, ".flow", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    await fs.mkdir(path.join(workspace, ".flow", "state", "in-progress"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".flow", "state", "done"), { recursive: true });

    // Native-adapter config.
    await atomicWriteFile(
      path.join(workspace, ".flow", "config.yaml"),
      `adapter: native\nadapter_config: {}\n`,
    );

    // Seed the cited source so T0-5 resolvability passes.
    await atomicWriteFile(path.join(workspace, "src", "state", "ledger.ts"), "// seeded\n");

    // Author a native story — writeNativeStory auto-materialises the manifest.
    const { ref } = await writeNativeStory({
      targetRepoRoot: workspace,
      title: "Persist the backlog ledger",
      narrative: {
        role: "operator",
        want: "the plugin to write sprint-status.yaml",
        so_that: "the backlog ledger is durable",
      },
      acceptance_criteria: [
        {
          text: "**Given** a backlog, **When** the operator runs it, **Then** sprint-status.yaml is updated and read back unchanged.",
          kind: "integration" as const,
          verification: { type: "vitest" as const, target: "src/__tests__/ledger.integration.test.ts" },
        },
      ],
      tasks: [{ text: "Write the ledger persistence path", ac_refs: ["AC1"] }],
      cited_sources: ["src/state/ledger.ts"],
      depends_on: [],
      risk_reasoning: "Highest risk: ledger write silently succeeds but read-back finds stale data — caught by the integration AC round-trip assertion.",
      sessionUlid: SESSION_ULID,
    });

    // Confirm the manifest was auto-materialised.
    const manifestPath = path.join(workspace, ".flow", "state", "to-do", `${ref}.yaml`);
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();

    // Run a subsequent manual scan — the idempotency invariant must hold.
    const secondScan = await scanSources({ targetRepoRoot: workspace });

    // The ref must appear in unchangedRefs (hash matches, no overwrite).
    expect(secondScan.unchangedRefs).toContain(ref);

    // It must NOT appear in createdRefs — no duplicate manifest written.
    expect(secondScan.createdRefs).not.toContain(ref);

    // And not in updatedRefs — the source file was not changed.
    expect(secondScan.updatedRefs).not.toContain(ref);
  });
});
