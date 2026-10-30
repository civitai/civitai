import { createBuzzClient } from '@civitai/buzz';
import { env } from '$env/dynamic/private';

// Lazy: a missing BUZZ_ENDPOINT throws on first use, not at boot.
let client: ReturnType<typeof createBuzzClient> | undefined;

export function getBuzz(): ReturnType<typeof createBuzzClient> {
  if (!client) client = createBuzzClient({ endpoint: env.BUZZ_ENDPOINT });
  return client;
}
