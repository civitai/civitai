import { env } from '~/env/server.mjs';
import { parseKey } from './s3-utils';

const deliveryWorkerEndpoint = `${env.DELIVERY_WORKER_ENDPOINT}?token=${env.DELIVERY_WORKER_TOKEN}`;

env.CF_ACCOUNT_ID


export type DownloadInfo = {
  url: string;
  urlExpiryDate: Date;
};

export async function getDownloadUrl(fileUrl: string, fileName?: string) {  
  const { key } = parseKey(fileUrl);

  const response = await fetch(deliveryWorkerEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, fileName }),
  });

  const result = await response.json();
  return result as DownloadInfo;
}