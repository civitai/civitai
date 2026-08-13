import { z } from 'zod';
import { checkbox, optionalBuzz, optionalBuzzField, freePreviewsField } from './form-fields';
// Relative, not `$lib`: this module is unit-tested by the app's plain node vitest project, which has no
// SvelteKit plugin and so cannot resolve the alias — an aliased import here fails COLLECTION, which reads
// as zero tests rather than as a failure.
import { MIN_GENERATION_PRICE } from '../../monetization/paid-access';

// Split out of `paid-access.ts` so it can be unit-tested: that module imports `$env/dynamic/private`
// for the main-app URL, which is unresolvable under the node test runner and makes the whole suite fail
// to COLLECT — reported as zero tests, not as a failure.

// Validates the paid-access editor form → a PaidAccessConfig. Light shape validation only; the main-app
// endpoint (updateEarlyAccessConfigSchema) is the source of truth for prices, per-user limits, side effects.
export const paidAccessFormSchema = z
  .object({
    timeframe: z.coerce.number().int().min(0),
    permanent: checkbox,
    // On-site-generation-only versions charge via the generation price (no download tier).
    usageControl: z.string().optional(),
    accessPrice: optionalBuzz,
    generationPrice: optionalBuzzField(MIN_GENERATION_PRICE),
    // The generation choice itself, so a priceless "separate" tier can be refused here rather than
    // stored as something indistinguishable from "bundled". Optional: an older page or a scripted POST
    // that omits it keeps working, and the refine only bites when `separate` is explicitly claimed.
    genMode: z.enum(['bundled', 'separate', 'free']).optional(),
    freeGeneration: checkbox,
    acceptsBlueBuzz: checkbox,
    freePreviewGenerations: freePreviewsField(),
    donationGoalEnabled: checkbox,
    donationGoal: optionalBuzz,
  })
  .refine((v) => v.permanent || v.timeframe > 0, {
    message: 'Set an early access duration, or make it permanent.',
  })
  // Every gated version needs an access price. For a gen-only version it's written as the generation price.
  .refine((v) => v.accessPrice != null && v.accessPrice > 0, {
    message: 'Enter a price for access.',
  })
  .refine(
    (v) => v.generationPrice == null || v.accessPrice == null || v.generationPrice <= v.accessPrice,
    { message: 'Generation-only price cannot be greater than the access price.' }
  )
  // A "separate" tier with no price falls back to the DOWNLOAD price (see `generationPrice` in
  // @civitai/buzz), so the screen says cheaper while the buyer pays full. The stored terms can't be told
  // apart from a deliberate bundle afterwards, which is why this is refused at the write boundary.
  .refine((v) => v.genMode !== 'separate' || v.generationPrice != null, {
    message: 'Enter a generation-only price, or choose "Same as the access price".',
  });
