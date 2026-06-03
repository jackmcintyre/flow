import { z } from "zod";
export declare const CreateSmokeScratchRepoOptionsSchema: z.ZodObject<{
    label: z.ZodString;
    parentDir: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type CreateSmokeScratchRepoOptions = z.infer<typeof CreateSmokeScratchRepoOptionsSchema>;
export interface CreateSmokeScratchRepoResult {
    scratchRoot: string;
    cleanup: () => Promise<void>;
}
/**
 * Create a disposable smoke-harness scratch repo seeded with:
 *  - git init (deterministic `main` branch) + an empty commit
 *  - minimal `.flow/config.yaml` (native adapter, empty standards)
 *  - `.flow/standards.md` copied from the shipped `docs/standards-example.md`
 *
 * Returns `{ scratchRoot, cleanup }` where `cleanup` is an idempotent
 * `fs.rm(scratchRoot, { recursive: true, force: true })` closure.
 *
 * Used by the `/flow:smoke` skill as the first checkpoint step (Story 1.13).
 */
export declare function createSmokeScratchRepo(opts: CreateSmokeScratchRepoOptions): Promise<CreateSmokeScratchRepoResult>;
