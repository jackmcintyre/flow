import { z } from "zod";
export declare const TeamSnapshotRoleSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    state: z.ZodLiteral<"ok">;
    role: z.ZodString;
    domain: z.ZodString;
    fireCount: z.ZodNumber;
    knowledge: z.ZodArray<z.ZodString>;
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
        knowledge: z.ZodArray<z.ZodString>;
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
