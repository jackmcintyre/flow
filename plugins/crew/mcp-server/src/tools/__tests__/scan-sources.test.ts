/**
 * Integration test for Story 9.1 (AC5): the scan step writes new backlog
 * manifests with `ready` defaulting to `false`, so a just-scanned item is in
 * the backlog but NOT claimable until the operator blesses it.
 *
 * Scans a single native source story into a fresh `to-do/` manifest, asserts
 * the written manifest reads not-ready, and asserts the claim entry point
 * (`claimNextStory`) does not return it (fail-closed readiness brake).
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
import { claimNextStory, QUEUE_DRAINED_LINE } from "../claim-next-story.js";

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
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crew-scan-sources-ready-"));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("scan-sources Story 9.1 (AC5) — fresh manifests default ready: false", () => {
  it("writes a freshly-scanned manifest as not-ready and the claim entry point does not return it", async () => {
    const root = path.join(scratch, "workspace");
    await fs.mkdir(root);

    const storiesDir = path.join(root, ".crew", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    // The claim path stats these directories — create them so it does not error.
    await fs.mkdir(path.join(root, ".crew", "state", "in-progress"), { recursive: true });
    await fs.mkdir(path.join(root, ".crew", "state", "done"), { recursive: true });

    // Native-adapter config.
    await atomicWriteFile(
      path.join(root, ".crew", "config.yaml"),
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
    const manifestPath = path.join(root, ".crew", "state", "to-do", `${STORY_REF}.yaml`);
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = yamlParse(raw) as Record<string, unknown>;
    expect(parsed["ready"]).toBe(false);
    // status is unaffected by the brake.
    expect(parsed["status"]).toBe("to-do");

    // (ii) The claim entry point does not return it — fail-closed.
    const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid: SESSION_ULID });
    expect(claim.next).toBe("queue-drained");
    expect(claim.chatLog).toContain(QUEUE_DRAINED_LINE);
  });
});
