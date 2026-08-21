import { createStorageClient } from '@civitai/storage';
import { env } from '$env/dynamic/private';

let client: ReturnType<typeof createStorageClient> | undefined;

export function getStorage(): ReturnType<typeof createStorageClient> {
  if (!client)
    client = createStorageClient({ endpoint: env.STORAGE_ENDPOINT, token: env.STORAGE_TOKEN });
  return client;
}
