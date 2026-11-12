import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newS3Client, S3_CLIENT_BOUNDS } from '~/utils/s3-client-factory';

// An S3 endpoint that accepts the connection and never answers must cost a bounded number of attempts and a
// bounded wait, not hold the caller forever (the SDK default: no socket timeout, 3 attempts).

let server: Server;
let endpoint: string;
let requests = 0;
let answer = false;

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests++;
    if (answer) res.writeHead(200, { 'content-length': '0' }).end();
    // otherwise: accept, never respond
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

const config = () => ({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'k', secretAccessKey: 's' },
});

describe('newS3Client', () => {
  it('rejects within its bounds against an endpoint that never answers, after maxAttempts', async () => {
    const client = newS3Client(config(), {
      connectionTimeoutMs: 500,
      requestTimeoutMs: 300,
      maxAttempts: 2,
    });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' })).then(
        () => 'resolved' as const,
        (err: Error) => err
      ),
      new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), 5000))),
    ]);
    clearTimeout(timer);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe('TimeoutError');
    expect(requests).toBe(2);
    // 2 x 300 ms plus the SDK's backoff between them; well under the 5 s the race allows.
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('hands the default bounds to the SDK handler and retry strategy', async () => {
    answer = true;
    const client = newS3Client(config());
    await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }));

    expect(await client.config.maxAttempts()).toBe(S3_CLIENT_BOUNDS.maxAttempts);
    expect(client.config.requestHandler.httpHandlerConfigs()).toMatchObject({
      connectionTimeout: S3_CLIENT_BOUNDS.connectionTimeoutMs,
      requestTimeout: S3_CLIENT_BOUNDS.requestTimeoutMs,
    });
  });

  it('lets a caller override maxAttempts (the retry-free probe client)', async () => {
    const client = newS3Client({ ...config(), maxAttempts: 1 });
    expect(await client.config.maxAttempts()).toBe(1);
  });
});
