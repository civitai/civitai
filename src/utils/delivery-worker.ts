import { env } from '~/env/server.mjs';
import { parseKey } from './s3-utils';

const deliveryWorkerEndpoint = `${env.DELIVERY_WORKER_ENDPOINT}?token=${env.DELIVERY_WORKER_TOKEN}`;

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
    throw new Error(response.statusText);
  }
  const result = await response.json();
  return result as DownloadInfo;
}
