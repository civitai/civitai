import * as z from 'zod';

// The form keeps paid-access config — the timed early-access window AND the permanent gate — in this
// UX-shaped local field; the API contract is `paidAccess` + `donationGoal`. The transforms across that
// boundary live in ModelVersionUpsertForm.
export const formPaidAccessConfigSchema = z.object({
  // Permanent = never-expiring gate (always paid); false = a timed Early Access window that becomes free.
  permanent: z.boolean().default(false),
  timeframe: z.number(),
  // "Price for access" — unlocks download + generation (the bundle). Required when charging.
  accessPrice: z.number().optional(),
  // Optional cheaper generation-only tier; defaults to the access price when unset.
  generationPrice: z.number().optional(),
  // Gate the download but leave generation free for everyone (no price, no trial limit).
  freeGeneration: z.boolean().default(false),
  // Accept Blue Buzz as payment at the same price — and be paid in it.
  acceptsBlueBuzz: z.boolean().default(false),
  // Free preview generations before purchase is required (the trial limit). Cleared/empty = 0 (no trial),
  // matching Creator Studio; a new gate seeds the default via the enable switch.
  freePreviewGenerations: z.preprocess(
    (v) => (v === '' || v == null || (typeof v === 'number' && Number.isNaN(v)) ? 0 : v),
    z.number().int()
  ),
  donationGoalEnabled: z.boolean().default(false),
  donationGoal: z.number().optional(),
});
export type FormPaidAccessConfig = z.infer<typeof formPaidAccessConfigSchema>;

/**
 * What a creator's last charging save for a model type is remembered as, so enabling monetization on the
 * next version of that type opens on the same numbers instead of an empty form.
 *
 * The donation goal is deliberately not remembered: it's a per-model fundraising target, create-once and
 * immutable, so carrying one across models would set a goal against a window nobody chose.
 */
export const monetizationDefaultsSchema = z.object({
  fee: z.object({
    buzz: z.number().int().min(0),
    images: z.number().int().positive(),
  }),
  paidAccess: formPaidAccessConfigSchema
    .omit({ donationGoalEnabled: true, donationGoal: true })
    .nullable(),
});
export type MonetizationDefaults = z.infer<typeof monetizationDefaultsSchema>;
