import { z } from "zod";
/**
 * `.flow/config.yaml` schema.
 *
 * The top-level shape is validated here. The active adapter validates
 * its own `adapter_config` block via the adapter's own Zod schema —
 * see PlanningAdapter.adapterConfigSchema.
 */
export declare const PluginSettingsSchema: z.ZodDefault<z.ZodObject<{
    agreement_threshold: z.ZodDefault<z.ZodNumber>;
    orchestration_interval_seconds: z.ZodDefault<z.ZodNumber>;
    provisional_trust: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>>;
export declare const WorkspaceConfigSchema: z.ZodObject<{
    adapter: z.ZodString;
    adapter_config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    plugin: z.ZodDefault<z.ZodObject<{
        agreement_threshold: z.ZodDefault<z.ZodNumber>;
        orchestration_interval_seconds: z.ZodDefault<z.ZodNumber>;
        provisional_trust: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type PluginSettings = z.infer<typeof PluginSettingsSchema>;
