import type { PersonaFile } from "../schemas/persona.js";
export interface ReadPersonaOptions {
    targetRepoRoot: string;
    role: string;
}
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
export declare function readPersona(opts: ReadPersonaOptions): Promise<PersonaFile>;
