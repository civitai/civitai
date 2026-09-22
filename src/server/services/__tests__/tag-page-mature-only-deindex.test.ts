import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

import { getTagPageSeoData, shouldDeIndexMatureOnlyTag } from '~/server/services/tag.service';

/**
 * Green reads tag SEO data filtered to what green can show, so the meta description and the
 * CollectionPage schema never advertise mature models there. A tag whose published models are all
 * mature therefore reads as empty on green — Search Console files those pages as soft 404s — and
 * is noindexed; red, where that content is canonical, keeps it.
 */

// The predicates themselves live in tag-seo-domain-rules.test.ts, with their red counterparts.

describe('getTagPageSeoData', () => {
  const queryRaw = dbMock.dbRead.$queryRaw;

  beforeEach(() => {
    vi.clearAllMocks();
    // A cache miss that wins the stampede lock, so the origin queries run exactly once.
    redisMock.redis.packed.get.mockResolvedValue(null as never);
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
    dbMock.dbRead.tag.findFirst.mockResolvedValue({ id: 648156 } as never);
  });

  // The safe filter arrives as a nested Prisma.sql fragment, so render fragments inline.
  const sqlOf = (call: number) => {
    const [strings, ...values] = queryRaw.mock.calls[call] as unknown as [string[], ...unknown[]];
    return strings
      .map((part, i) => {
        const value = values[i] as { sql?: string } | undefined;
        return part + (typeof value?.sql === 'string' ? value.sql : '?');
      })
      .join('');
  };

  const SAFE = /"nsfw" = false/;

  // Promise.all issues the queries in declaration order: count, top models, then (green only)
  // the any-model check.
  function respondGreen(safeCount: number, anyModel: boolean) {
    queryRaw
      .mockResolvedValueOnce([{ count: BigInt(safeCount) }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ exists: anyModel }] as never);
  }

  it('green: reports a tag whose models are all mature', async () => {
    respondGreen(0, true);

    const result = await getTagPageSeoData({ name: 'mature-only', safeOnly: true });

    expect(result).toMatchObject({ count: 0, hasModels: true });
    expect(shouldDeIndexMatureOnlyTag(result)).toBe(true);
  });

  it('green: filters the count and the listed models to safe models', async () => {
    respondGreen(3, true);

    await getTagPageSeoData({ name: 'mixed', safeOnly: true });

    expect(sqlOf(0)).toMatch(SAFE);
    expect(sqlOf(1)).toMatch(SAFE);
  });

  it('green: checks for ANY model without the safe filter', async () => {
    respondGreen(0, true);

    await getTagPageSeoData({ name: 'mature-only', safeOnly: true });

    expect(sqlOf(2)).toMatch(/EXISTS/);
    expect(sqlOf(2)).not.toMatch(SAFE);
  });

  // Red queries count, top models, then the mature count — no any-model check.
  function respondRed(count: number, matureCount: number) {
    queryRaw
      .mockResolvedValueOnce([{ count: BigInt(count) }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ count: BigInt(matureCount) }] as never);
  }

  it('red: leaves the count and models unfiltered and skips the any-model check', async () => {
    respondRed(5, 2);

    const result = await getTagPageSeoData({ name: 'mixed', safeOnly: false });

    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(sqlOf(0)).not.toMatch(SAFE);
    expect(sqlOf(1)).not.toMatch(SAFE);
    expect(sqlOf(2)).not.toMatch(/EXISTS/);
    expect(result).not.toHaveProperty('hasModels');
  });

  it('red: counts what green cannot show, as the exact complement of the safe filter', async () => {
    respondRed(5, 2);

    const result = await getTagPageSeoData({ name: 'mixed', safeOnly: false });

    // `count - matureCount` is consumed as green's share, so this must complement the safe
    // filter at both halves: an inclusive OR of "flagged nsfw" and "no public browsing bit".
    expect(sqlOf(2)).toMatch(/"nsfw" = true/);
    expect(sqlOf(2)).toMatch(/OR/);
    expect(sqlOf(2)).toMatch(/"nsfwLevel" & \$?\d*\)? = 0|"nsfwLevel" & \?\) = 0/);
    expect(result.matureCount).toBe(2);
  });

  it('green: carries no mature count, which is what keeps the red rules off it', async () => {
    respondGreen(3, true);

    const result = await getTagPageSeoData({ name: 'mixed', safeOnly: true });

    expect(result).not.toHaveProperty('matureCount');
  });

  it('caches the green and red variants under different versioned keys', async () => {
    respondGreen(0, true);
    await getTagPageSeoData({ name: 'Same-Tag', safeOnly: true });
    respondRed(5, 2);
    await getTagPageSeoData({ name: 'Same-Tag', safeOnly: false });

    const keys = redisMock.redis.packed.get.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(2);
    // The version segment is what stops a v1 red entry, which has no `matureCount`, reaching
    // code whose rules read it as "nothing mature here".
    for (const key of keys) expect(key).toContain(':v3:');
  });

  it('cannot be tricked into serving a red payload as green', async () => {
    // The name is raw user text, so the variant has to be decided before it, not after.
    respondGreen(0, true);
    await getTagPageSeoData({ name: 'anime', safeOnly: true });
    respondRed(5, 2);
    await getTagPageSeoData({ name: 'anime:safe', safeOnly: false });

    const [greenKey, redKey] = redisMock.redis.packed.get.mock.calls.map(([key]) => key);
    expect(greenKey).not.toBe(redKey);
  });
});
