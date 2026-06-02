import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PersonaFileNotFoundError } from "../errors.js";
import { parsePersonaFile } from "../lib/persona-file.js";
/**
 * Read a persona file from `<targetRepoRoot>/team/<role>/PERSONA.md`
 * and return its parsed `PersonaFile`. Pure read — no mutation, no
 * writes, no telemetry.
 *
 * - Throws `PersonaFileNotFoundError` on ENOENT.
 * - Throws `PersonaFileMalformedError` (via `parsePersonaFile`) if the
 *   file exists but fails the parser.
 *
 * (Story 2.3 FR93, FR96 — text-editor edits round-trip through this
 * reader.)
 */
export async function readPersona(opts) {
    const personaPath = path.join(opts.targetRepoRoot, "team", opts.role, "PERSONA.md");
    let raw;
    try {
        raw = await fs.readFile(personaPath, "utf8");
    }
    catch (err) {
        if (isEnoent(err)) {
            throw new PersonaFileNotFoundError({
                role: opts.role,
                personaPath,
            });
        }
        throw err;
    }
    return parsePersonaFile(raw, personaPath);
}
function isEnoent(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
