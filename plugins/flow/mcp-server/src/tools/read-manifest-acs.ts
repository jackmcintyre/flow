/**
 * `readManifestAcs` — extract acceptance-criteria entries from an execution
 * manifest and return them in the same shape as `extractAcsFromSpec`.
 *
 * Story native:01KT6QGBWP7KJDVMHQK3MEKDXP (inline-spec-to-builder).
 *
 * Native stories carry their spec in `.flow/native-stories/<ulid>.md` — a
 * gitignored, local-only folder that is absent from an isolated worktree
 * checkout. The drain orchestrator (which runs in the full checkout where
 * `.flow/` is present) calls this tool after claiming a native story to
 * extract the ACs from the execution manifest and pass them inline to the
 * builder subagent. The builder then passes `inlineAcs` to
 * `runDevTerminalAction`, which skips the `extractAcsFromSpec` file-read and
 * uses the pre-extracted entries directly.
 *
 * The manifest's `acceptance_criteria` array carries the full AC text
 * (`text` field), `kind`, and optional `verification` metadata — the same
 * information the spec file carries. This tool converts each entry into an
 * `AcEntry`-compatible object by:
 *   - Assigning a 1-based numeric `index` (AC1, AC2, …).
 *   - Deriving `firstLine` from the first non-blank line of the `text`.
 *   - Deriving `tag` from the `kind` field (present when kind is `integration`,
 *     null otherwise — mirroring the `(integration)` / `(unit)` tag that the
 *     spec file parser would emit for a tagged AC heading).
 *   - Splitting the full `text` into `body` lines.
 */

import { readManifest } from "../lib/manifest-io.js";

export interface ManifestAcEntry {
  index: number;
  firstLine: string;
  tag: string | null;
  body: string[];
}

export interface ReadManifestAcsResult {
  acs: ManifestAcEntry[];
}

/**
 * Read the execution manifest at `manifestPath` and return its
 * `acceptance_criteria` as an array of `AcEntry`-compatible objects.
 *
 * @param opts.manifestPath  Absolute path to the in-progress manifest YAML.
 * @returns `{ acs }` — one entry per AC, in numeric order.
 */
export async function readManifestAcs(opts: {
  manifestPath: string;
}): Promise<ReadManifestAcsResult> {
  const { manifestPath } = opts;
  const manifest = await readManifest(manifestPath);

  const acs: ManifestAcEntry[] = (manifest.acceptance_criteria ?? []).map(
    (ac, i) => {
      const lines = ac.text.split("\n");

      // firstLine: first non-blank line of the AC text, truncated to 120 chars.
      // Mirrors the extractAcsFromSpec logic.
      const firstLine =
        lines.find((l) => l.trim().length > 0)?.trim().slice(0, 120) ?? "";

      // tag: derive from the `kind` field.
      //   - "integration" → "integration"  (mirrors `(integration)` in the spec)
      //   - "unit"        → null            (unit ACs are typically untagged)
      // Callers that need the raw kind can look it up in the manifest directly;
      // this derivation preserves backward compatibility with the AcEntry shape.
      const tag = ac.kind === "integration" ? "integration" : null;

      return {
        index: i + 1,
        firstLine,
        tag,
        body: lines,
      };
    },
  );

  return { acs };
}
