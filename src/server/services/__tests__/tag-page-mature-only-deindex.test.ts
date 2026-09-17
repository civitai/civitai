import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

import type { TagPageSeoData } from '~/server/services/tag.service';
import { getTagPageSeoData, shouldDeIndexMatureOnlyTag } from '~/server/services/tag.service';

/**
 * Green reads tag SEO data filtered to what green can show, so the meta description and the
 * CollectionPage schema never advertise mature models there. A tag whose published models are all
 * mature therefore reads as empty on green — Search Console files those pages as soft 404s — and
 * is noindexed; red, where that content is canonical, keeps it.
 */

const seo = (overrides: Partial<TagPageSeoData>): TagPageSeoData => ({
  count: 0,
  models: [],
  ...overrides,
});

describe('shouldDeIndexMatureOnlyTag', () => {
  it('deindexes a tag whose models are all mature', () => {
    expect(shouldDeIndexMatureOnlyTag(seo({ count: 0, hasModels: true }))).toBe(true);
  });

  it('keeps a tag with any safe model indexed', () => {
    expect(shouldDeIndexMatureOnlyTag(seo({ count: 2, hasModels: true }))).toBe(false);
  });

  it('leaves a tag with no models at all alone', () => {
    expect(shouldDeIndexMatureOnlyTag(seo({ count: 0, hasModels: false }))).toBe(false);
  });

  it('never fires for a red read, which carries no hasModels', () => {
    expect(shouldDeIndexMatureOnlyTag(seo({ count: 0 }))).toBe(false);
  });
});

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

  it('red: leaves the count and models unfiltered and skips the any-model check', async () => {
    queryRaw
      .mockResolvedValueOnce([{ count: BigInt(5) }] as never)
      .mockResolvedValueOnce([] as never);

    const result = await getTagPageSeoData({ name: 'mixed', safeOnly: false });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlOf(0)).not.toMatch(SAFE);
    expect(sqlOf(1)).not.toMatch(SAFE);
    expect(result).not.toHaveProperty('hasModels');
  });

  it('caches the green and red variants under different keys', async () => {
    respondGreen(0, true);
    await getTagPageSeoData({ name: 'Same-Tag', safeOnly: true });
    queryRaw
      .mockResolvedValueOnce([{ count: BigInt(5) }] as never)
      .mockResolvedValueOnce([] as never);
    await getTagPageSeoData({ name: 'Same-Tag', safeOnly: false });

    const keys = redisMock.redis.packed.get.mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(2);
  });
});
