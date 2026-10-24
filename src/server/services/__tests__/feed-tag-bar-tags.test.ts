import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';

const redisGet = redisMock.redis.get;
const redisSet = redisMock.redis.set;
const redisDel = redisMock.redis.del;
// The service reads through `dbRead` only; aliasing both clients would let a write-path
// regression pass on the read client's calls.
const queryRaw = dbMock.dbRead.$queryRaw;

const CACHE_KEY = REDIS_KEYS.SYSTEM.FEED_TAG_BAR_TAGS;

const row = (id: number, name: string, nsfwLevel = 1) => ({ id, name, nsfwLevel });

async function load() {
  vi.resetModules();
  return await import('~/server/services/system-cache');
}

/**
 * The chip list feeds a client-side gate on `nsfwLevel`, so the number this returns is a
 * browsing-level decision, not a display detail.
 */
describe('getFeedTagBarTags', () => {
  beforeEach(() => {
    redisGet.mockReset().mockResolvedValue(null);
    redisSet.mockReset().mockResolvedValue('OK');
    redisDel.mockReset().mockResolvedValue(1);
    queryRaw.mockReset().mockResolvedValue([]);
  });

  // 🔴 The one that matters. No app path writes `Tag."nsfwLevel"`; a tag's effective level
  // is raised by attaching it to a mature parent in `TagsOnTags`, and `getTags` resolves it
  // with exactly this COALESCE. Selecting the bare column instead reports a stale level
  // permanently — not for a cache window — and the client would keep the chip at every
  // browsing level.
  it('resolves nsfwLevel through the parent-tag rollup, not the raw column', async () => {
    const { getFeedTagBarTags } = await load();
    await getFeedTagBarTags();

    // $queryRaw is a tagged template: arg 0 is the strings array (the SQL), the rest are
    // the interpolated values. Joining the strings DROPS the values, so the tag names are
    // asserted separately below — do not read this join as "the whole query".
    const sql = (queryRaw.mock.calls[0][0] as unknown as string[]).join(' ');

    expect(sql).toMatch(/TagsOnTags/);
    expect(sql).toMatch(/MAX\(pt\."nsfwLevel"\)/);
    expect(sql).toMatch(/COALESCE/);
  });

  it('asks for exactly the curated names', async () => {
    const { getFeedTagBarTags } = await load();
    const { FEED_TAG_BAR_TAG_NAMES } = await import('~/server/common/feed-tag-bar.constants');
    await getFeedTagBarTags();

    // One `= ANY($1)` array parameter, so the names arrive as a single template value —
    // not as 22, and not inside the SQL string. Asserting on the string join would find
    // nothing and pass for the wrong reason.
    const names = queryRaw.mock.calls[0][1] as unknown as string[];
    expect(names).toEqual([...FEED_TAG_BAR_TAG_NAMES]);
  });

  it('returns the curated display order, not the order the DB happened to return', async () => {
    queryRaw.mockResolvedValue([row(1776, 'steampunk'), row(4, 'anime'), row(111768, 'animal')]);
    const { getFeedTagBarTags } = await load();

    expect((await getFeedTagBarTags()).map((t) => t.name)).toEqual([
      'animal',
      'anime',
      'steampunk',
    ]);
  });

  it('carries the rollup level through to the caller', async () => {
    queryRaw.mockResolvedValue([row(4, 'anime', 8), row(111768, 'animal', 1)]);
    const { getFeedTagBarTags } = await load();

    expect(await getFeedTagBarTags()).toEqual([
      { id: 111768, name: 'animal', nsfwLevel: 1 },
      { id: 4, name: 'anime', nsfwLevel: 8 },
    ]);
  });

  it('drops a name that resolves to no row, keeping the rest', async () => {
    queryRaw.mockResolvedValue([row(4, 'anime'), row(111768, 'animal')]);
    const { getFeedTagBarTags } = await load();

    const names = (await getFeedTagBarTags()).map((t) => t.name);
    expect(names).toEqual(['animal', 'anime']);
    expect(names).not.toContain('steampunk');
  });

  it('serves the redis blob without touching the DB', async () => {
    redisGet.mockResolvedValue(JSON.stringify([row(4, 'anime')]));
    const { getFeedTagBarTags } = await load();

    expect(await getFeedTagBarTags()).toEqual([{ id: 4, name: 'anime', nsfwLevel: 1 }]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('writes the resolved list back to redis', async () => {
    queryRaw.mockResolvedValue([row(4, 'anime')]);
    const { getFeedTagBarTags } = await load();
    await getFeedTagBarTags();

    expect(redisSet).toHaveBeenCalledWith(
      CACHE_KEY,
      JSON.stringify([{ id: 4, name: 'anime', nsfwLevel: 1 }]),
      expect.objectContaining({ EX: expect.any(Number) })
    );
  });
});

/**
 * Without this the corrected level could not be pushed at all — the redis blob holds for
 * 4h and the per-pod memo would keep serving the value it already had.
 */
describe('clearFeedTagBarTagsCache', () => {
  beforeEach(() => {
    redisGet.mockReset().mockResolvedValue(null);
    redisSet.mockReset().mockResolvedValue('OK');
    redisDel.mockReset().mockResolvedValue(1);
    queryRaw.mockReset().mockResolvedValue([]);
  });

  it('deletes the redis blob and re-reads on the next call', async () => {
    queryRaw.mockResolvedValue([row(4, 'anime')]);
    const { getFeedTagBarTags, clearFeedTagBarTagsCache } = await load();

    await getFeedTagBarTags();
    await getFeedTagBarTags();
    // Positive control: the memo is doing its job, so a second query below can only come
    // from the clear.
    expect(queryRaw).toHaveBeenCalledTimes(1);

    await clearFeedTagBarTagsCache();
    expect(redisDel).toHaveBeenCalledWith(CACHE_KEY);

    await getFeedTagBarTags();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
