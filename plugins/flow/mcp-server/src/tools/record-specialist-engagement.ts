/**
 * `recordSpecialistEngagement` CLI tool — Story native:01KVPSZ14HH48J9NEH7N6S6QDR.
 *
 * Writes `engaged_specialist: <roleId>` onto the in-progress execution manifest,
 * recording that the named specialist was auto-engaged for this story alongside
 * the generalists (Story native:01KVPSZ14HH48J9NEH7N6S6QDR AC1/AC2).
 *
 * This is the WRITE seam for specialist participation recording. The run calls
 * it after `matchStorySpecialist` returns a non-null role, before the dev build
 * starts:
 *   node dist/cli.js recordSpecialistEngagement \
 *     --json '{"targetRepoRoot":"...","ref":"native:...","sessionUlid":"...","specialistRole":"<role>"}'
 *
 * **Idempotent on repeat.** If `engaged_specialist` is already set to the same
 * role, the manifest is re-written with the same value (no error).
 *
 * **Not a state-machine transition.** This tool only updates a field on the
 * in-progress manifest; it does NOT move the manifest between directories.
 * The manifest remains in in-progress/ after this call.
 *
 * **Fail-soft on claim mismatch.** The run calls this BEFORE the dev build in
 * the same session, so a session-id mismatch is a real error and propagates.
 * Callers should treat this as idempotent and swallow errors if they cannot
 * re-verify the claim.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ManifestNotFoundError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";

/** Strip keys with `undefined` values before YAML stringification. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export interface RecordSpecialistEngagementOptions {
  targetRepoRoot: string;
  /** Manifest ref (e.g. `"native:01HZ…"`). */
  ref: string;
  /** Session ULID — must match `claimed_by` on the manifest. */
  sessionUlid: string;
  /** Role id of the specialist to record as engaged. */
  specialistRole: string;
}

export interface RecordSpecialistEngagementResult {
  ok: true;
  ref: string;
  specialistRole: string;
}

/**
 * Write `engaged_specialist` onto the in-progress execution manifest.
 *
 * @throws {ManifestNotFoundError} When the manifest is not found in in-progress/.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema validation.
 */
export async function recordSpecialistEngagement(
  opts: RecordSpecialistEngagementOptions,
): Promise<RecordSpecialistEngagementResult> {
  const { targetRepoRoot, ref, sessionUlid, specialistRole } = opts;

  const absPath = path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "in-progress",
    `${ref}.yaml`,
  );

  let rawText: string;
  try {
    rawText = await fs.readFile(absPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new ManifestNotFoundError({
        ref,
        expectedAbsPath: absPath,
        fromState: "in-progress",
      });
    }
    throw err;
  }

  const parsed = yamlParse(rawText) as unknown;
  const manifest = parseExecutionManifest(parsed, { absPath });

  // Session-id check: only the claiming session should be writing this field.
  // A mismatch here is unusual (the run always records before spawning dev),
  // so propagate it rather than silently ignoring.
  if (manifest.claimed_by !== sessionUlid) {
    throw new Error(
      `recordSpecialistEngagement: session mismatch — manifest.claimed_by=${manifest.claimed_by ?? "<unset>"} but sessionUlid=${sessionUlid}`,
    );
  }

  // Merge in the engaged_specialist field.
  const updated = { ...manifest, engaged_specialist: specialistRole };
  const reparsed = parseExecutionManifest(updated, { absPath });
  const yamlText = yamlStringify(
    stripUndefined(reparsed as unknown as Record<string, unknown>),
    { lineWidth: 0 },
  );

  await writeManagedFile({
    absPath,
    contents: yamlText,
    targetRepoRoot,
    mcpToolContext: { toolName: "recordSpecialistEngagement", role: "orchestrator" },
  });

  return { ok: true, ref, specialistRole };
}
