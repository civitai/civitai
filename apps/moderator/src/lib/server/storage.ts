import { createStorageClient } from '@civitai/storage';
import { env } from '$env/dynamic/private';

// The spoke's storage-service client — the same shared @civitai/storage HTTP client the main app uses (an
// internal-only client to the storage app, which holds the bucket creds and fronts S3). Lets the spoke
// delete S3 objects directly instead of routing through the main app. Lazy: a missing STORAGE_ENDPOINT
// surfaces on first use, not at boot.
let client: ReturnType<typeof createStorageClient> | undefined;

export function getStorage(): ReturnType<typeof createStorageClient> {
  if (!client)
    client = createStorageClient({ endpoint: env.STORAGE_ENDPOINT, token: env.STORAGE_TOKEN });
  return client;
}
