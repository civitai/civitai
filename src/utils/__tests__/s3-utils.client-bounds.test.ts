import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Every S3 client s3-utils hands out must carry the connect/socket timeouts and the attempt cap, or a
// never-answering endpoint holds its caller indefinitely. Each getter's client sends one request to a
// local stub, then the SDK's own resolved handler config and retry cap are read back.

const h = vi.hoisted(() => ({ endpoint: '' }));

vi.mock('~/env/server', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop.endsWith('_ENDPOINT')) return h.endpoint || 'https://s3.example.test';
      if (/_(ACCESS_KEY|SECRET_KEY|UPLOAD_KEY|UPLOAD_SECRET)$/.test(prop)) return 'test-credential';
      if (prop === 'S3_UPLOAD_BUCKET') return 'bucket';
      if (prop === 'S3_UPLOAD_REGION') return 'us-east-1';
      return undefined;
    },
  }),
}));

import {
  getB2ImageProbeS3Client,
  getB2ImageS3Client,
  getB2S3Client,
  getQuarantineS3Client,
  getS3Client,
} from '~/utils/s3-utils';

let server: Server;

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { 'content-length': '0' }).end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  h.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function boundsOf(client: S3Client) {
  await client.send(new HeadObjectCommand({ Bucket: 'bucket', Key: 'k' }));
  const handler = client.config.requestHandler.httpHandlerConfigs() as {
    connectionTimeout?: number;
    requestTimeout?: number;
  };
  return {
    maxAttempts: await client.config.maxAttempts(),
    connectionTimeout: handler.connectionTimeout,
    requestTimeout: handler.requestTimeout,
  };
}

const bounded = { maxAttempts: 2, connectionTimeout: 3_000, requestTimeout: 30_000 };

describe('s3-utils clients', () => {
  it.each([
    ['getS3Client', () => getS3Client()],
    ['getB2S3Client', () => getB2S3Client()],
    ['getB2ImageS3Client', () => getB2ImageS3Client()],
    ['getQuarantineS3Client', () => getQuarantineS3Client() as S3Client],
  ])('%s carries the connect/socket timeouts and a 2-attempt cap', async (_name, get) => {
    expect(await boundsOf(get())).toEqual(bounded);
  });

  it('the probe client keeps its single attempt and gets the same timeouts', async () => {
    expect(await boundsOf(getB2ImageProbeS3Client())).toEqual({ ...bounded, maxAttempts: 1 });
  });

  it('reuses one client per configuration instead of building one per call', () => {
    expect(getB2S3Client()).toBe(getB2S3Client());
    expect(getS3Client()).toBe(getS3Client());
  });
});
