import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (h: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      h(...args),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/verify';

const signed = readFileSync(
  path.join(__dirname, '../../../server/services/__tests__/fixtures/c2pa/CA.jpg')
);

async function post(body: Buffer, headers: Record<string, string>) {
  vi.mocked(getServerAuthSession).mockResolvedValue(null as never);
  const { req, res } = createRealApiPair({ method: 'POST', url: '/api/v1/verify', headers });
  (req as unknown as NodeJS.ReadableStream & { push: (b: Buffer | null) => void }).push(body);
  (req as unknown as { push: (b: null) => void }).push(null);
  let json: Record<string, unknown> | undefined;
  const send = res.json.bind(res);
  res.json = ((b: unknown) => {
    json = b as Record<string, unknown>;
    return send(b);
  }) as typeof res.json;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res.statusCode, json };
}

describe('POST /api/v1/verify', () => {
  beforeEach(() => {
    redisMock.redis.incrBy.mockResolvedValue(1);
  });

  it('reads a signed upload', async () => {
    const { status, json } = await post(signed, { 'content-length': String(signed.length) });
    expect(status).toBe(200);
    expect(json).toMatchObject({ credentials: 'valid' });
  });

  it('refuses an upload with no Content-Length, which the proxy could have truncated', async () => {
    const { status } = await post(signed, {});
    expect(status).toBe(411);
  });

  it('refuses a body shorter than its Content-Length rather than reading it as tampered', async () => {
    const { status, json } = await post(signed.subarray(0, 50_000), {
      'content-length': String(signed.length),
    });
    expect(status).toBe(400);
    expect(json).toMatchObject({ code: 'BAD_REQUEST', message: 'Upload body was incomplete' });
  });
});
