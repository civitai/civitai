import { callMainApp } from '$lib/server/main-app';

// `licensingFee` and `usageControl` are written straight to the shared database with kysely (see
// licensing-fee.ts / paid-access.ts), which the main app's caches can't observe. Without this the change
// stays invisible on-site until the TTL lapses — up to a day for some of them.
//
// Fire-and-forget on purpose: the write already succeeded and is the thing the creator asked for, so a
// bust that fails must not turn a saved change into an error toast. The cost of missing one is a stale
// read that expires on its own.
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
  // The result is deliberately ignored — see above. `callMainApp` never throws.
  //
  // 🔴 Bounded, because "fire-and-forget" was only ever true of the ERROR, not of the wait. Every caller
  // awaits this after its write has already committed, so an unresponsive main app held the creator's
  // form action open indefinitely — measured at 150s+ against a cold dev server while a refusal on the
  // same endpoint returned in under a second. What the creator saw was not "it didn't save"; it was a
  // saved change spinning with nothing to read. The timeout returns that to the stale-read-until-TTL
  // cost the comment above already accepts.
  await callMainApp(ENDPOINT, cookie, {
    method: 'POST',
    body: { versionIds },
    parse: false,
    timeoutMs: BUST_TIMEOUT_MS,
  });
}
