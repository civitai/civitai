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

  const body = JSON.stringify({
    key: decodeURIComponent(key),
    fileName: fileName ? decodeURIComponent(fileName) : undefined,
  });
  const response = await fetch(deliveryWorkerEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) throw new Error(response.statusText);
  const result = await response.json();
  return result as DownloadInfo;
}
