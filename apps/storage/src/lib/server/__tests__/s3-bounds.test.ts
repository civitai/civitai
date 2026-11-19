import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildS3Client, createS3Client, S3_CLIENT_BOUNDS } from '../s3';

// A backend that accepts the connection and never answers must cost the storage service a bounded wait and a
// bounded number of attempts, not an open request (the SDK default: no socket timeout, 3 attempts).

let server: Server;
let endpoint: string;
let requests = 0;
let answer = false;

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests++;
    if (answer) res.writeHead(200, { 'content-length': '0' }).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  requests = 0;
  answer = false;
});

const backend = () => ({
  endpoint,
  accessKey: 'k',
  secretKey: 's',
  bucket: 'b',
  forcePathStyle: true,
});

/** The SDK's resolved HTTP handler config (populated once the handler has served a request). */
function handlerConfig(client: { config: { requestHandler: unknown } }) {
  return (
    client.config.requestHandler as { httpHandlerConfigs(): Record<string, unknown> }
  ).httpHandlerConfigs();
}

describe('storage S3 client bounds', () => {
  it.each(['off', 'OFF', '0', 'false'])(
    'S3_CLIENT_TIMEOUTS=%s builds clients without the timeouts (the off-switch)',
    async (value) => {
      answer = true;
      process.env.S3_CLIENT_TIMEOUTS = value;
      try {
        const client = buildS3Client(backend());
        await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }));
        const handler = handlerConfig(client);
        expect(handler.connectionTimeout).toBeUndefined();
        expect(handler.requestTimeout).toBeUndefined();
      } finally {
        delete process.env.S3_CLIENT_TIMEOUTS;
      }
    }
  );

  it('headObject against a backend that never answers rejects within the bounds, after maxAttempts', async () => {
    const s3 = createS3Client(backend(), {
      bounds: { connectionTimeoutMs: 500, requestTimeoutMs: 300 },
      maxAttempts: 2,
    });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      s3.headObject('some/key').then(
        () => 'resolved' as const,
        (err: Error) => err
      ),
      new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), 5000))),
    ]);
    clearTimeout(timer);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe('TimeoutError');
    expect(requests).toBe(2);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('builds clients with the default bounds when none are passed', async () => {
    answer = true;
    const client = buildS3Client(backend());
    await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }));

    expect(await client.config.maxAttempts()).toBe(3); // the SDK default, untouched
    expect(handlerConfig(client)).toMatchObject({
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      // Sized past smithy's 50: connectionTimeout also covers waiting for a free socket.
      httpAgent: { maxSockets: 256 },
      httpsAgent: { maxSockets: 256 },
    });
  });
});
