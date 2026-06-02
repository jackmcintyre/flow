/**
 * Pure JSONL aggregator for telemetry fire counts (Story 2.6 / FR108 /
 * NFR28).
 *
 * This is the FIRST reader of the `.flow/telemetry/<YYYY-MM>.jsonl` files
 * written by `lib/logger.ts`. The writer/reader split is intentional:
 *  - Writer: `logger.ts` (via `logTelemetryEvent`). Appends, emits
 *    `telemetry.invalid` on Zod failure.
 *  - Reader: this file. Reads, counts, reports malformation back to the
 *    caller. NEVER writes; NEVER emits `telemetry.invalid`.
 *
 * v1 template for Epic 6's `computeOutcomeStats` and `computeAgreement`
 * helpers — keep small and single-purpose.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { TelemetryEventSchema } from "../schemas/telemetry-events.js";

/** Month-bucket filename pattern matching the Story 1.5 logger contract. */
const MONTH_BUCKET_REGEX = /^\d{4}-\d{2}\.jsonl$/;

export interface TeamTelemetryStats {
  /** Per-agent invocation counts from `agent.invoke` events. */
  fireCountsByAgent: Record<string, number>;
  /** Total count of lines that failed JSON.parse or Zod validation. */
  malformedLines: number;
  /** Count of files that contained at least one malformed line. */
  malformedFiles: number;
}

/**
 * Read and aggregate `agent.invoke` telemetry from
 * `<targetRepoRoot>/.flow/telemetry/*.jsonl`.
 *
 * - Absent telemetry directory → `{ fireCountsByAgent: {}, malformedLines: 0, malformedFiles: 0 }`.
 * - Each file whose name matches `^\d{4}-\d{2}\.jsonl$` is read and
 *   every non-empty line is validated via `TelemetryEventSchema`.
 * - Valid `agent.invoke` events increment `fireCountsByAgent[agent]`.
 * - Other valid event types (e.g. `telemetry.invalid`) are counted as
 *   valid — they do NOT increment `malformedLines`.
 * - Lines that fail JSON.parse or Zod increment `malformedLines`.
 * - `malformedFiles` counts files with ≥1 malformed line.
 *
 * No writes. No network IO. No `execa`. No clock dependency.
 */
export async function readTeamTelemetryStats(opts: {
  targetRepoRoot: string;
}): Promise<TeamTelemetryStats> {
  const telemetryDir = path.join(opts.targetRepoRoot, ".flow", "telemetry");

  let entries: string[];
  try {
    entries = await fs.readdir(telemetryDir);
  } catch (err) {
    if (isEnoent(err)) {
      return { fireCountsByAgent: {}, malformedLines: 0, malformedFiles: 0 };
    }
    throw err;
  }

  const fireCountsByAgent: Record<string, number> = {};
  let malformedLines = 0;
  let malformedFiles = 0;

  for (const entry of entries) {
    if (!MONTH_BUCKET_REGEX.test(entry)) {
      continue;
    }

    const filePath = path.join(telemetryDir, entry);
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n");

    let fileHasMalformation = false;

    for (const line of lines) {
      // Trailing-newline tolerance: skip empty lines (per Task 2.7 /
      // Story 1.5 logger contract — every JSONL line ends with `\n`).
      if (line.trim() === "") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedLines++;
        fileHasMalformation = true;
        continue;
      }

      const result = TelemetryEventSchema.safeParse(parsed);
      if (!result.success) {
        malformedLines++;
        fileHasMalformation = true;
        continue;
      }

      // Only `agent.invoke` events count toward fire counts. Other valid
      // event types are tolerated but not aggregated.
      if (result.data.type === "agent.invoke") {
        const agent = result.data.agent;
        fireCountsByAgent[agent] = (fireCountsByAgent[agent] ?? 0) + 1;
      }
    }

    if (fileHasMalformation) {
      malformedFiles++;
    }
  }

  return { fireCountsByAgent, malformedLines, malformedFiles };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
