import { createBuzzClient } from '@civitai/buzz';
import { env } from '$env/dynamic/private';

// The spoke's buzz-service client. Same shared @civitai/buzz client the main app uses (an HTTP client to
// the buzz microservice — no DB), so the spoke can refund/transact directly instead of routing through the
// main app. Lazy: a missing BUZZ_ENDPOINT throws on first use, not at boot.
let client: ReturnType<typeof createBuzzClient> | undefined;

export function getBuzz(): ReturnType<typeof createBuzzClient> {
  if (!client) client = createBuzzClient({ endpoint: env.BUZZ_ENDPOINT });
  return client;
}
