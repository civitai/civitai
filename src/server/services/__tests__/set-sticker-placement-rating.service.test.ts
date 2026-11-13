import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Caches from '~/server/redis/caches';
import { setStickerPlacementRatingSchema } from '~/server/schema/cosmetic.schema';
import { CosmeticFlag } from '~/shared/constants/cosmetic-flags.constants';

const COSMETIC = 317;
const BOTH = CosmeticFlag.SfwPlacementsOnly | CosmeticFlag.NsfwPlacementsOnly;
const OTHER_BIT = 1 << 5;

const cosmeticCacheRefresh = vi.fn<(id: number) => Promise<undefined>>(async () => undefined);
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const real = await importOriginal<typeof Caches>();
  return { ...real, cosmeticCache: { ...real.cosmeticCache, refresh: cosmeticCacheRefresh } };
});

const queryRaw = dbMock.dbWrite.$queryRaw;

const { setStickerPlacementRating } = await import('~/server/services/cosmetic.service');

/** The statement as Postgres receives it, with the values in order. */
const issuedSql = () => {
  const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
};

/** The issued SET expression, evaluated against a stored value. */
const applyIssuedUpdate = (stored: number) => {
  const { sql, values } = issuedSql();
  // The JS below mirrors this expression, so it means nothing unless the SQL matches it.
  expect(sql).toMatch(/SET flags = \(flags & ~\?::int\) \| \?/);
  const [mask, bits] = values as number[];
  return (stored & ~mask) | bits;
};

beforeEach(() => {
  queryRaw.mockReset();
  cosmeticCacheRefresh.mockClear();
});

describe('setStickerPlacementRating', () => {
  it.each([
    ['any', CosmeticFlag.None],
    ['sfwOnly', CosmeticFlag.SfwPlacementsOnly],
    ['nsfwOnly', CosmeticFlag.NsfwPlacementsOnly],
  ] as const)('%s writes its own bit over both', async (rating, expected) => {
    queryRaw.mockResolvedValue([{ flags: expected }]);

    await setStickerPlacementRating({ id: COSMETIC, rating });

    const { sql, values } = issuedSql();
    expect(sql).toMatch(/SET flags = \(flags & ~\?::int\) \| \?/);
    expect(sql).toMatch(/WHERE id = \? AND type = 'Sticker'::"CosmeticType"/);
    expect(values).toEqual([BOTH, expected, COSMETIC]);
  });

  it.each([
    [
      'sfwOnly over nsfwOnly',
      'sfwOnly',
      CosmeticFlag.NsfwPlacementsOnly,
      CosmeticFlag.SfwPlacementsOnly,
    ],
    [
      'nsfwOnly over sfwOnly',
      'nsfwOnly',
      CosmeticFlag.SfwPlacementsOnly,
      CosmeticFlag.NsfwPlacementsOnly,
    ],
    ['nsfwOnly over both', 'nsfwOnly', BOTH, CosmeticFlag.NsfwPlacementsOnly],
    ['any over both', 'any', BOTH, CosmeticFlag.None],
    [
      'nsfwOnly beside an unrelated bit',
      'nsfwOnly',
      OTHER_BIT | CosmeticFlag.SfwPlacementsOnly,
      OTHER_BIT | CosmeticFlag.NsfwPlacementsOnly,
    ],
  ] as const)('%s leaves exactly one rating bit', async (_label, rating, stored, expected) => {
    queryRaw.mockResolvedValue([{ flags: expected }]);

    await setStickerPlacementRating({ id: COSMETIC, rating });

    expect(applyIssuedUpdate(stored)).toBe(expected);
  });

  it('refreshes the cached cosmetic, which is what hides live placements', async () => {
    queryRaw.mockResolvedValue([{ flags: CosmeticFlag.None }]);

    await expect(setStickerPlacementRating({ id: COSMETIC, rating: 'any' })).resolves.toEqual({
      id: COSMETIC,
      flags: CosmeticFlag.None,
    });
    expect(cosmeticCacheRefresh).toHaveBeenCalledWith(COSMETIC);
  });

  it('refuses a sticker that does not exist, and refreshes nothing', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(setStickerPlacementRating({ id: COSMETIC, rating: 'nsfwOnly' })).rejects.toThrow(
      /doesn't exist/
    );
    expect(cosmeticCacheRefresh).not.toHaveBeenCalled();
  });
});

describe('setStickerPlacementRatingSchema', () => {
  it.each(['any', 'sfwOnly', 'nsfwOnly'])('accepts %s', (rating) => {
    expect(setStickerPlacementRatingSchema.safeParse({ id: COSMETIC, rating }).success).toBe(true);
  });

  // No input names both bits, so the server cannot be asked to set them together.
  it.each([['both'], [BOTH], [CosmeticFlag.NsfwPlacementsOnly], [undefined]])(
    'refuses %s',
    (rating) => {
      expect(setStickerPlacementRatingSchema.safeParse({ id: COSMETIC, rating }).success).toBe(
        false
      );
    }
  );
});
