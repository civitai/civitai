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

  const response = await fetch(deliveryWorkerEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, fileName }),
  });

  if (!response.ok) throw new Error(response.statusText);
  const result = await response.json();
  return result as DownloadInfo;
}

export async function getDeliveryWorkerStatus() {
  const url = new URL(deliveryWorkerEndpoint);
  url.pathname = 'status';

  const response = await fetch(url.toString());
  const result = (await response.json()) as DeliveryWorkerStatus;

  return result;
}
