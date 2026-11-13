import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { REDIS_KEYS } from '@civitai/redis/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { headBlob, fetchThroughCache } = vi.hoisted(() => ({
  headBlob: vi.fn(),
  fetchThroughCache: vi.fn(),
}));
const redis = redisMock.redis;

// Hand-listed: the real package cannot load in the node test environment (directory imports).
vi.mock('@civitai/orchestration-client', () => ({
  headBlob,
  NsfwLevel: { PG: 'pg', PG13: 'pg13', R: 'r', X: 'x', XXX: 'xxx', NA: 'na' },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ createOrchestratorClient: () => ({}) }));
vi.mock('~/env/server', () => ({ env: { ORCHESTRATOR_ACCESS_TOKEN: 'system' } }));
// Pass-through: what is under test is what the refill returns or throws, not the cache.
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache }));

const { readBlobState } = await import('~/server/services/orchestrator/blobRatings');

const answered = (status: number, headers: Record<string, string> = {}) => ({
  response: new Response(null, { status, headers }),
});

beforeEach(() => {
  vi.clearAllMocks();
  redis.exists.mockResolvedValue(0 as never);
  redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
  fetchThroughCache.mockImplementation((_key: string, fetcher: () => Promise<unknown>) => {
    lastRefill = fetcher;
    return fetcher();
  });
});

/** The refill the cache was handed. It must throw for anything that is not a verdict, or the cache would store it. */
let lastRefill: (() => Promise<unknown>) | undefined;
const refillIsNotCached = () => expect(lastRefill!()).rejects.toThrow();

const backedOff = () =>
  expect(redis.setNxKeepTtlWithEx).toHaveBeenCalledWith(
    `${REDIS_KEYS.CACHES.BLOCK_MEDIA_BLOB_STATE_BACKOFF}:b1`,
    '1',
    5
  );

describe('readBlobState', () => {
  it('CONTROL: a 200 with a level and a location is a rated verdict', async () => {
    headBlob.mockResolvedValue(answered(200, { 'X-NSFW-Level': 'R', Location: 'https://cdn/b1' }));
    expect(await readBlobState('b1')).toEqual({
      verdict: 'rated',
      nsfwLevel: 'r',
      blockedReason: null,
      location: 'https://cdn/b1',
    });
  });

  it('a block header is a rated verdict carrying the block', async () => {
    headBlob.mockResolvedValue(answered(200, { 'X-Blocked-Reason': 'tos' }));
    expect(await readBlobState('b1')).toMatchObject({ verdict: 'rated', blockedReason: 'tos' });
  });

  it('🔴 an `NA` blob whose blocked reason is `none` reads as unblocked, so it hides as unrated', async () => {
    headBlob.mockResolvedValue(
      answered(200, {
        'X-NSFW-Level': 'NA',
        'X-Blocked-Reason': 'none',
        Location: 'https://cdn/b1',
      })
    );
    expect(await readBlobState('b1')).toEqual({
      verdict: 'rated',
      nsfwLevel: 'na',
      blockedReason: null,
      location: 'https://cdn/b1',
    });
  });

  it('🔴 while backed off it is pending and sends no HEAD', async () => {
    redis.exists.mockResolvedValue(1 as never);
    expect(await readBlobState('b1')).toEqual({ verdict: 'pending' });
    expect(headBlob).not.toHaveBeenCalled();
  });

  it('🔴 a HEAD that throws is pending and backs off', async () => {
    headBlob.mockRejectedValue(new Error('ECONNRESET'));
    expect(await readBlobState('b1')).toEqual({ verdict: 'pending' });
    backedOff();
  });

  it('🔴 a HEAD that times out is pending and backs off', async () => {
    headBlob.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    expect(await readBlobState('b1')).toEqual({ verdict: 'pending' });
    backedOff();
  });

  it('🔴 a 503 (scan pending) is pending and is never cached as a verdict', async () => {
    headBlob.mockResolvedValue(answered(503));
    expect(await readBlobState('b1')).toEqual({ verdict: 'pending' });
    expect(redis.setNxKeepTtlWithEx).not.toHaveBeenCalled();
    await refillIsNotCached();
  });

  it.each([500, 404])('🔴 a %i is pending and backs off', async (status) => {
    headBlob.mockResolvedValue(answered(status, { 'X-NSFW-Level': 'PG' }));
    expect(await readBlobState('b1')).toEqual({ verdict: 'pending' });
    backedOff();
  });

  it('🔴 a 200 with neither a level nor a block is pending', async () => {
    headBlob.mockResolvedValue(answered(200, { Location: 'https://cdn/b1' }));
    expect(await readBlobState('b1')).toEqual({ verdict: 'pending' });
    await refillIsNotCached();
  });

  it('🔴 a refill held by another request (the cache throws) is pending', async () => {
    fetchThroughCache.mockRejectedValue(new Error('lock held'));
    expect(await readBlobState('b1')).toEqual({ verdict: 'pending' });
  });

  it('a redis outage on the backoff check still reads the blob', async () => {
    redis.exists.mockRejectedValue(new Error('redis down') as never);
    headBlob.mockResolvedValue(answered(200, { 'X-NSFW-Level': 'PG', Location: 'https://cdn/b1' }));
    expect(await readBlobState('b1')).toMatchObject({ verdict: 'rated', nsfwLevel: 'pg' });
  });
});
