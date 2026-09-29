import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Caches from '~/server/redis/caches';
import { CosmeticFlag } from '~/shared/constants/cosmetic-flags.constants';

const COSMETIC = 317;

const cosmeticCacheRefresh = vi.fn<(id: number) => Promise<undefined>>(async () => undefined);
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const real = await importOriginal<typeof Caches>();
  return { ...real, cosmeticCache: { ...real.cosmeticCache, refresh: cosmeticCacheRefresh } };
});

const queryRaw = dbMock.dbWrite.$queryRaw;

const { setCosmeticFlag } = await import('~/server/services/cosmetic.service');

/** The statement as Postgres receives it, with the values in order. */
const issuedSql = () => {
  const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
};

beforeEach(() => {
  queryRaw.mockReset();
  cosmeticCacheRefresh.mockClear();
});

describe('setCosmeticFlag', () => {
  // Both directions: the switch's own value is what picks the branch, so a
  // condition that ignored or inverted it would pass a one-direction check.
  it.each([true, false])('writes one row with the switch set to %s', async (enabled) => {
    queryRaw.mockResolvedValue([{ flags: CosmeticFlag.None }]);

    await setCosmeticFlag({ id: COSMETIC, flag: CosmeticFlag.SfwPlacementsOnly, enabled });

    const { sql, values } = issuedSql();
    expect(sql).toMatch(/SET flags = CASE WHEN \? THEN flags \| \? ELSE flags & ~\?::int END/);
    expect(sql).toMatch(/WHERE id = \?/);
    expect(values).toEqual([
      enabled,
      CosmeticFlag.SfwPlacementsOnly,
      CosmeticFlag.SfwPlacementsOnly,
      COSMETIC,
    ]);
  });

  it('refreshes the cached cosmetic, which is what hides live placements', async () => {
    queryRaw.mockResolvedValue([{ flags: CosmeticFlag.None }]);

    await expect(
      setCosmeticFlag({ id: COSMETIC, flag: CosmeticFlag.SfwPlacementsOnly, enabled: false })
    ).resolves.toEqual({ id: COSMETIC, flags: CosmeticFlag.None });
    expect(cosmeticCacheRefresh).toHaveBeenCalledWith(COSMETIC);
  });

  it('refuses a cosmetic that does not exist, and refreshes nothing', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(
      setCosmeticFlag({ id: COSMETIC, flag: CosmeticFlag.SfwPlacementsOnly, enabled: true })
    ).rejects.toThrow(/doesn't exist/);
    expect(cosmeticCacheRefresh).not.toHaveBeenCalled();
  });
});
