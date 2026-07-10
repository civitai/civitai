import { env } from '$env/dynamic/private';
import type { EarlyAccessConfig } from '$lib/monetization/early-access';

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
