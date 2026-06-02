import { z } from "zod";
/**
 * `.flow/config.yaml` schema.
 *
 * The top-level shape is validated here. The active adapter validates
 * its own `adapter_config` block via the adapter's own Zod schema —
 * see PlanningAdapter.adapterConfigSchema.
 */
export const PluginSettingsSchema = z
    .object({
    agreement_threshold: z.number().min(0).max(1).default(0.8),
    orchestration_interval_seconds: z.number().int().positive().default(120),
    /**
     * Cold-start provisional trust (Stage-2). When `true`, the auto-merge gate
     * may merge a `low`-risk PR while agreement history is still accruing (the
     * agreement window has not yet filled) — bootstrapping trust on the safest
     * changes until the threshold gate has enough signal. Default `false`: the
     * gate pauses for a human. Only ever relaxes the `low` + insufficient-data
     * branch; medium/high/untiered always pause regardless. Operator-controlled
     * with NO auto-expiry in v1 — turn it off once the agreement window fills
     * so the real threshold gate takes over.
     */
    provisional_trust: z.boolean().default(false),
})
    .default(() => ({
    agreement_threshold: 0.8,
    orchestration_interval_seconds: 120,
    provisional_trust: false,
}));
export const WorkspaceConfigSchema = z.object({
    adapter: z.string().min(1),
    adapter_config: z.record(z.string(), z.unknown()).default({}),
    plugin: PluginSettingsSchema,
});
