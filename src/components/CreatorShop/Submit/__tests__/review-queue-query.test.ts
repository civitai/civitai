import { describe, expect, it } from 'vitest';
import {
  statusFromQuery,
  typesFromQuery,
} from '~/components/CreatorShop/Submit/review-queue-query';
import type { StatusFilter } from '~/components/CreatorShop/Submit/review-queue-query';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import { PACK_FILTER_VALUE } from '~/server/schema/creator-shop.schema';

const options: { value: StatusFilter }[] = [
  { value: CosmeticShopItemStatus.PendingReview },
  { value: CosmeticShopItemStatus.Published },
  { value: 'all' },
];

describe('statusFromQuery', () => {
  it('reads a status regardless of how the link cased it', () => {
    // The nav link is hand-written lowercase; the enum is PascalCase. A
    // case-sensitive match would drop the filter and open the default queue,
    // which looks like the link working.
    expect(statusFromQuery('pendingreview', options)).toBe(CosmeticShopItemStatus.PendingReview);
    expect(statusFromQuery('PendingReview', options)).toBe(CosmeticShopItemStatus.PendingReview);
    expect(statusFromQuery(' published ', options)).toBe(CosmeticShopItemStatus.Published);
    expect(statusFromQuery('all', options)).toBe('all');
  });

  it('returns null for anything it does not recognise, so the caller can default', () => {
    expect(statusFromQuery('nonsense', options)).toBeNull();
    expect(statusFromQuery(undefined, options)).toBeNull();
    expect(statusFromQuery(['pendingreview'], options)).toBeNull();
  });
});

describe('typesFromQuery', () => {
  it('reads the comma form the page writes', () => {
    expect(typesFromQuery('sticker')).toEqual([CosmeticType.Sticker]);
    expect(typesFromQuery('sticker,badge')).toEqual([CosmeticType.Sticker, CosmeticType.Badge]);
  });

  it('reads the repeated-key form a hand-written link may use', () => {
    expect(typesFromQuery(['sticker', 'badge'])).toEqual([
      CosmeticType.Sticker,
      CosmeticType.Badge,
    ]);
  });

  it('keeps packs, which are in the queue but are not a CosmeticType', () => {
    expect(typesFromQuery(PACK_FILTER_VALUE)).toEqual([PACK_FILTER_VALUE]);
  });

  it('drops unknown types instead of passing them to the query', () => {
    expect(typesFromQuery('sticker,banana')).toEqual([CosmeticType.Sticker]);
    expect(typesFromQuery('banana')).toEqual([]);
    expect(typesFromQuery(undefined)).toEqual([]);
  });

  it('dedupes, so a repeated type does not render two identical chips', () => {
    expect(typesFromQuery('sticker,sticker')).toEqual([CosmeticType.Sticker]);
  });
});
