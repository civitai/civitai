import { env } from '$env/dynamic/private';

// `licensingFee` and `usageControl` are written straight to the shared database with kysely (see
// licensing-fee.ts / paid-access.ts), which the main app's caches can't observe. Without this the change
// stays invisible on-site until the TTL lapses — up to a day for some of them.
//
// Fire-and-forget on purpose: the write already succeeded and is the thing the creator asked for, so a
// bust that fails must not turn a saved change into an error toast. The cost of missing one is a stale
// read that expires on its own.
const MAIN_APP_URL = env.CIVITAI_APP_URL || 'https://civitai.com';
const ENDPOINT = '/api/v1/model-versions/bust-cache';

export async function bustVersionCache(cookie: string, versionIds: number[]): Promise<void> {
  if (!versionIds.length) return;
  try {
    await fetch(`${MAIN_APP_URL}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ versionIds }),
    });
  } catch {
    // Swallowed: see above.
  }
}
