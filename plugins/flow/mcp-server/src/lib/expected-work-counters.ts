/**
 * Shared "expected-work counters" shape and pure render helper.
 *
 * Surfaces the three counters an operator needs to trust that a scan or run
 * found nothing because the queue is genuinely empty — not because files were
 * silently dropped or stories were quietly held back.
 *
 * Story native:01KTSR3E7FE61XB2PN8VJ24289.
 */

/**
 * One rejected source file with the reason it was not usable.
 */
export interface RejectedFile {
  /** Basename of the file as it appeared in the stories directory. */
  filename: string;
  /** Why it was rejected. */
  reason: "bad-filename";
}

/**
 * One story that was held back from claiming, with the reason it was parked.
 */
export interface HeldRef {
  ref: string;
  reason:
    | "unmerged-dependency"
    | "unmerged-overlap"
    | "pending-overlap"
    | "deps-not-done"
    | "not-ready";
}

/**
 * The shared counters shape. All three surfaces (scan summary, claim/queue
 * step, backlog dashboard) render this identical shape so the operator reads
 * the same line format everywhere.
 */
export interface ExpectedWorkCounters {
  /** Total number of candidate files the adapter saw in the stories directory. */
  filesSeenCount: number;
  /** Files that were seen but could not be used (e.g. bad filename). */
  filesRejected: RejectedFile[];
  /** Stories that were held back (ready but blocked by a hold condition). */
  refsHeld: HeldRef[];
}

/**
 * Pure renderer for `ExpectedWorkCounters`. Produces a single human-readable
 * line (or multi-line block when there are rejections/holds to name).
 *
 * The format is deterministic — same input always produces the same output.
 * It is intentionally terse: the zero case ("all clear") is an explicit line,
 * not silence.
 *
 * @returns One or more lines (joined by `\n`) ready to append to a summary.
 */
export function renderExpectedWorkCounters(counters: ExpectedWorkCounters): string {
  const { filesSeenCount, filesRejected, refsHeld } = counters;
  const lines: string[] = [];

  // Files line
  const rejectedCount = filesRejected.length;
  if (rejectedCount === 0) {
    lines.push(
      `expected-work: ${filesSeenCount} file(s) seen, 0 rejected, ${refsHeld.length} held`,
    );
  } else {
    lines.push(
      `expected-work: ${filesSeenCount} file(s) seen, ${rejectedCount} rejected, ${refsHeld.length} held`,
    );
    for (const f of filesRejected) {
      lines.push(`  rejected: ${f.filename} (${f.reason})`);
    }
  }

  // Held refs
  if (refsHeld.length > 0) {
    for (const h of refsHeld) {
      lines.push(`  held: ${h.ref} (${h.reason})`);
    }
  }

  return lines.join("\n");
}
