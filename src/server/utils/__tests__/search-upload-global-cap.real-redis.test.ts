import { randomUUID } from 'crypto';
import { pack } from 'msgpackr';
import type { NextApiRequest } from 'next';
import { createClient, RESP_TYPES } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The site-wide search-by-upload caps against a real Redis and the real claim script, as in
 * rate-limit-bucket.real-redis.test.ts: CI's unit job sets ROSTER_REDIS_URL; elsewhere this runs
 * only when it is set. Production-like env, since the limiter exempts dev/test/preview.
 */
const url = process.env.ROSTER_REDIS_URL;
if (process.env.CI && !url)
  throw new Error('ROSTER_REDIS_URL is not set: CI runs a Redis for this');

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isDev: false,
  isProd: true,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

const { redisMock } = await import('~/__tests__/mocks/redis.mock');
const { rateLimitBucket } = await import('~/server/utils/rate-limit-bucket');
const { claimSearchUploadSearchSlot, SEARCH_UPLOAD_GLOBAL_DAILY_SEARCH_CAP } = await import(
  '~/server/services/image-search-upload.service'
);

const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } } as unknown as NextApiRequest;
const BUCKET = rateLimitBucket('imageSearchUpload:global-search', { id: 0 } as never, req);

describe.skipIf(!url)('the site-wide upload search cap on a real Redis', () => {
  const real = createClient({ url });
  const binary = real.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
  // The bucket's key is fixed, so the run moves it under its own prefix: never a shared key.
  const prefix = `search-upload-cap-${randomUUID().slice(0, 8)}:`;
  const own = (key: string) => (key === BUCKET.cacheKey ? prefix + key : key);

  beforeAll(async () => {
    await real.connect();
    redisMock.redis.packed.hGet.mockImplementation(async (key: string, field: string) => {
      const value = (await binary.hGet(own(key), field)) as Buffer | null;
      const { unpack } = await import('msgpackr');
      return value == null ? null : unpack(value);
    });
    redisMock.redis.eval.mockImplementation(((
      script: string,
      options: { keys: string[]; arguments: string[] }
    ) => real.eval(script, { ...options, keys: options.keys.map(own) })) as never);
  });
  afterAll(async () => {
    await real.del(prefix + BUCKET.cacheKey);
    await real.quit();
  });

  it('admits the last page under the cap and refuses the next', async () => {
    const now = Date.now();
    const used = Array.from(
      { length: SEARCH_UPLOAD_GLOBAL_DAILY_SEARCH_CAP - 1 },
      (_, i) => now - 3_600_000 + i
    );
    await real.hSet(prefix + BUCKET.cacheKey, BUCKET.hashKey, pack(used));
    await expect(claimSearchUploadSearchSlot(req)).resolves.toBeUndefined();
    await expect(claimSearchUploadSearchSlot(req)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('the claim script itself refuses at the cap, when a stale read lets the pre-check pass', async () => {
    const now = Date.now();
    const full = Array.from(
      { length: SEARCH_UPLOAD_GLOBAL_DAILY_SEARCH_CAP },
      (_, i) => now - 3_600_000 + i
    );
    await real.hSet(prefix + BUCKET.cacheKey, BUCKET.hashKey, pack(full));
    redisMock.redis.packed.hGet.mockResolvedValueOnce([]);
    await expect(claimSearchUploadSearchSlot(req)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('refuses when the claim script errors', async () => {
    await real.del(prefix + BUCKET.cacheKey);
    redisMock.redis.eval.mockRejectedValueOnce(
      new Error('ERR user_script:12: attempt to index a nil value')
    );
    await expect(claimSearchUploadSearchSlot(req)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});
