import { z } from "zod";
/**
 * A single structured knowledge entry as rendered by `getTeamSnapshot`.
 *
 * - `kind`         — closed lesson-kind enum (pitfall|pattern|tool-quirk|discipline).
 * - `applies_when` — short summary line shown in the /flow:team display.
 * - `detail`       — full lesson text.
 * - `source_ref`   — optional story ref provenance.
 */
export declare const KnowledgeEntrySchema: z.ZodObject<{
    kind: z.ZodEnum<{
        discipline: "discipline";
        pattern: "pattern";
        pitfall: "pitfall";
        "tool-quirk": "tool-quirk";
    }>;
    applies_when: z.ZodString;
    detail: z.ZodString;
    source_ref: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export declare const TeamSnapshotRoleSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    state: z.ZodLiteral<"ok">;
    role: z.ZodString;
    domain: z.ZodString;
    fireCount: z.ZodNumber;
    knowledge: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            discipline: "discipline";
            pattern: "pattern";
            pitfall: "pitfall";
            "tool-quirk": "tool-quirk";
        }>;
        applies_when: z.ZodString;
        detail: z.ZodString;
        source_ref: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strip>, z.ZodObject<{
    state: z.ZodLiteral<"error">;
    role: z.ZodString;
    error: z.ZodString;
}, z.core.$strip>], "state">;
export type TeamSnapshotRole = z.infer<typeof TeamSnapshotRoleSchema>;
export declare const TeamSnapshotSchema: z.ZodObject<{
    roles: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        state: z.ZodLiteral<"ok">;
        role: z.ZodString;
        domain: z.ZodString;
        fireCount: z.ZodNumber;
        knowledge: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                discipline: "discipline";
                pattern: "pattern";
                pitfall: "pitfall";
                "tool-quirk": "tool-quirk";
            }>;
            applies_when: z.ZodString;
            detail: z.ZodString;
            source_ref: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strip>, z.ZodObject<{
        state: z.ZodLiteral<"error">;
        role: z.ZodString;
        error: z.ZodString;
    }, z.core.$strip>], "state">>;
    knowledgeLimit: z.ZodNumber;
    malformedTelemetryLines: z.ZodNumber;
    malformedTelemetryFiles: z.ZodNumber;
}, z.core.$strict>;
export type TeamSnapshot = z.infer<typeof TeamSnapshotSchema>;
