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

// 🔴 Bounded, because "fire-and-forget" was only true of the ERROR, not of the wait. Every caller awaits
// this after its write has already committed, so an unresponsive main app held the creator's form action
// open indefinitely — measured at 150s+ against a cold dev server while a refusal on the same endpoint
// returned in under a second. The failure the creator sees is not "it didn't save"; it is a saved change
// spinning with nothing to read. A timeout turns that back into the stale-read-until-TTL cost the comment
// above already accepts.
const BUST_TIMEOUT_MS = 3000;

export async function bustVersionCache(cookie: string, versionIds: number[]): Promise<void> {
  if (!versionIds.length) return;
  try {
    await fetch(`${MAIN_APP_URL}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ versionIds }),
      signal: AbortSignal.timeout(BUST_TIMEOUT_MS),
    });
  } catch {
    // Swallowed: see above. An abort lands here like any other failure.
  }
}
