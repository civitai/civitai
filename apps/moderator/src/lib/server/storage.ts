import { createStorageClient } from '@civitai/storage';
import { env } from '$env/dynamic/private';

let client: ReturnType<typeof createStorageClient> | undefined;

export function getStorage(): ReturnType<typeof createStorageClient> {
  if (!client)
    client = createStorageClient({ endpoint: env.STORAGE_ENDPOINT, token: env.STORAGE_TOKEN });
  return client;
}

let probeClient: ReturnType<typeof createStorageClient> | undefined;

/**
 * A SEPARATE client for existence probes that sit on a moderator's click path.
 *
 * The default config is `timeoutMs: 10_000, retries: 2` — up to three attempts plus backoff, so a
 * degraded store turns one click into ~31 s of waiting. That budget is right for the write
 * operations `getStorage()` serves and wrong for a guard: a probe that cannot answer quickly is
 * simply `unknown`, and `unknown` allows, so waiting longer buys nothing. Bounded to ONE attempt at
 * 5 s, matching the budget the main app's copy of this guard already uses.
 */
export function getMediaProbeStorage(): ReturnType<typeof createStorageClient> {
  if (!probeClient)
    probeClient = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT,
      token: env.STORAGE_TOKEN,
      timeoutMs: 5_000,
      retries: 0,
    });
  return probeClient;
}
