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
  const handler = handlerConfig(client) as {
    connectionTimeout?: number;
    requestTimeout?: number;
    httpAgent?: { maxSockets?: number };
    httpsAgent?: { maxSockets?: number };
  };
  return {
    maxAttempts: await client.config.maxAttempts(),
    connectionTimeout: handler.connectionTimeout,
    requestTimeout: handler.requestTimeout,
    maxSockets: [handler.httpAgent?.maxSockets, handler.httpsAgent?.maxSockets],
  };
}

// Attempts stay at the SDK default (3); only the connect and idle timeouts are added.
// connectionTimeout also covers waiting for a free socket, so the memoised client's pool is sized well
// past smithy's default of 50; otherwise call 51+ under load fails at the connect timeout instead of
// queueing.
const bounded = {
  maxAttempts: 3,
  connectionTimeout: 10_000,
  requestTimeout: 30_000,
  maxSockets: [256, 256],
};

/** The SDK's resolved HTTP handler config (populated once the handler has served a request). */
function handlerConfig(client: { config: { requestHandler: unknown } }) {
  return (
    client.config.requestHandler as { httpHandlerConfigs(): Record<string, unknown> }
  ).httpHandlerConfigs();
}

describe('s3-utils clients', () => {
  it.each([
    ['getS3Client', () => getS3Client()],
    ['getB2S3Client', () => getB2S3Client()],
    ['getB2ImageS3Client', () => getB2ImageS3Client()],
    ['getQuarantineS3Client', () => getQuarantineS3Client() as S3Client],
  ])('%s carries the connect/socket timeouts and the default attempts', async (_name, get) => {
    expect(await boundsOf(get())).toEqual(bounded);
  });

  it('the probe client keeps its single attempt and gets the same timeouts', async () => {
    expect(await boundsOf(getB2ImageProbeS3Client())).toEqual({ ...bounded, maxAttempts: 1 });
  });

  it('reuses one client per configuration instead of building one per call', () => {
    expect(getB2S3Client()).toBe(getB2S3Client());
    expect(getS3Client()).toBe(getS3Client());
  });

  it.each(['off', 'OFF', '0', 'false'])(
    'S3_CLIENT_TIMEOUTS=%s is a full rollback: a fresh client per call, as before',
    (value) => {
      process.env.S3_CLIENT_TIMEOUTS = value;
      try {
        expect(getS3Client()).not.toBe(getS3Client());
        expect(getB2S3Client()).not.toBe(getB2S3Client());
      } finally {
        delete process.env.S3_CLIENT_TIMEOUTS;
      }
    }
  );
});
