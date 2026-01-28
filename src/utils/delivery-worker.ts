import { env } from '~/env/server';
import { parseKey } from './s3-utils';

const deliveryWorkerEndpoint = `${env.DELIVERY_WORKER_ENDPOINT}?token=${env.DELIVERY_WORKER_TOKEN}`;
const storageResolverEndpoint = env.STORAGE_RESOLVER_ENDPOINT;
const storageResolverAuth = env.STORAGE_RESOLVER_AUTH; // format: username:password

export type DownloadInfo = {
  url: string;
  urlExpiryDate: Date;
};

export type BucketInfo = {
  name: string;
  createdDate: Date;
};

export type DeliveryWorkerStatus = {
  current: BucketInfo | null;
  all: BucketInfo[];
};

/**
 * Get download URL via the storage-resolver microservice.
 * The resolver handles multi-backend storage (Cloudflare, Backblaze, MinIO).
 */
export async function getDownloadUrlByFileId(
  fileId: number,
  fileName?: string
): Promise<DownloadInfo> {
  if (!storageResolverEndpoint) {
    throw new Error('STORAGE_RESOLVER_ENDPOINT is not configured');
  }

  const body = JSON.stringify({
    fileId,
    fileName: fileName ? decodeURIComponent(fileName) : undefined,
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (storageResolverAuth) {
    headers['Authorization'] = `Basic ${Buffer.from(storageResolverAuth).toString('base64')}`;
  }

  const response = await fetch(`${storageResolverEndpoint}/resolve`, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Storage resolver error: ${errorText}`);
  }

  const result = await response.json();
  return {
    url: result.url,
    urlExpiryDate: new Date(result.urlExpiryDate),
  };
}

/**
 * Check if the storage resolver is enabled.
 */
export function isStorageResolverEnabled(): boolean {
  return !!storageResolverEndpoint;
}

/**
 * Get download URL via the delivery worker (legacy path).
 * Used when storage resolver is not configured.
 */
export async function getDownloadUrl(fileUrl: string, fileName?: string) {
  const { key } = parseKey(fileUrl);
  // Some of our old file keys should not be decoded.
  const keys = [decodeURIComponent(key), key];

  let i = 0;
  let response: Response = new Response();

  // We will test with all key configurations we can:
  while (i < keys.length) {
    const body = JSON.stringify({
      key: keys[i],
      fileName: fileName ? decodeURIComponent(fileName) : undefined,
    });

    response = await fetch(deliveryWorkerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    i++;

    if (response.ok) {
      break;
    }
  }

  if (!response.ok) {
    throw new Error(`Delivery worker error: ${response.statusText}`);
  }
  const result = await response.json();
  return result as DownloadInfo;
}
