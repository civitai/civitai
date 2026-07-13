import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { EarlyAccessConfig } from '$lib/monetization/early-access';
import { DEFAULT_GENERATION_TRIAL_LIMIT } from '$lib/monetization/early-access';

// Early access is written through the MAIN APP, not kysely: the write has real
// side effects (donation-goal rows, buzzTransactionId bookkeeping, publish-state
// guards, cache/search invalidation) that only the main app owns. We POST to its
// REST endpoint, forwarding the caller's shared .civitai.com session cookie so it
// authenticates + authorizes as that user. All validation lives server-side there.
const MAIN_APP_URL = env.CIVITAI_APP_URL || 'https://civitai.com';
const ENDPOINT = '/api/v1/model-versions/early-access';

export type { EarlyAccessConfig } from '$lib/monetization/early-access';
export { DEFAULT_GENERATION_TRIAL_LIMIT } from '$lib/monetization/early-access';

export type EarlyAccessResult = { ok: true } | { ok: false; status: number; error: string };

// Checkbox → boolean ('on'/'true' checked, absent = false); empty/absent number field → undefined.
const checkbox = z.preprocess((v) => v === 'on' || v === 'true', z.boolean());
const optionalBuzz = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number().optional()
);

// Validates the early-access editor form → an EarlyAccessConfig. Light shape validation only; the main-app
// endpoint (updateEarlyAccessConfigSchema) is the source of truth for prices, per-user limits, side effects.
export const earlyAccessFormSchema = z
  .object({
    timeframe: z.coerce.number().int().positive('Enter an early access duration (in days).'),
    chargeForDownload: checkbox,
    downloadPrice: optionalBuzz,
    chargeForGeneration: checkbox,
    generationPrice: optionalBuzz,
    generationTrialLimit: z.preprocess(
      (v) => (v === '' || v == null ? DEFAULT_GENERATION_TRIAL_LIMIT : Number(v)),
      z.number().int().min(0)
    ),
    donationGoalEnabled: checkbox,
    donationGoal: optionalBuzz,
    freeGeneration: checkbox,
  })
  .refine((v) => v.chargeForDownload || v.chargeForGeneration, {
    message: 'Charge for downloads and/or generations to enable early access.',
  });

// versionId + config (null clears early access). `cookie` is the incoming request's
// raw Cookie header, forwarded verbatim for auth.
export async function setEarlyAccessConfig(
  cookie: string,
  versionId: number,
  config: EarlyAccessConfig | null
): Promise<EarlyAccessResult> {
  try {
    const res = await fetch(`${MAIN_APP_URL}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: versionId, earlyAccessConfig: config }),
    });

    if (res.ok) return { ok: true };

    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      status: res.status,
      error: data?.error ?? `Request failed (${res.status}).`,
    };
  } catch {
    return {
      ok: false,
      status: 502,
      error: 'Could not reach the model service. Please try again.',
    };
  }
}
