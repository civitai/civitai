import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { registryIconUrl } from '~/server/registry-adapter/catalog-media';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import { listingIconUrl } from '~/server/services/blocks/listing-media-url';

/** A scanned, unflagged image at `nsfwLevel`, stored at `url`. */
const icon = (url: string, nsfwLevel: number): ListingMediaImage => ({
  url,
  nsfwLevel,
  ingestion: 'Scanned',
  needsReview: null,
  poi: false,
  minor: false,
  tosViolation: false,
  acceptableMinor: false,
  blockedFor: null,
});

describe('registryIconUrl — an app entity carries no icon rated above its rating tag', () => {
  it('a PG listing publishes its own PG icon', () => {
    expect(
      registryIconUrl({ contentRating: 'pg', icon: icon('icons/pg-own-a1', NsfwLevel.PG) })
    ).toBe(listingIconUrl({ url: 'icons/pg-own-a1' }));
  });

  it('🔴 a PG listing whose icon is rated R publishes no icon', () => {
    expect(
      registryIconUrl({ contentRating: 'pg', icon: icon('icons/pg-r-b2', NsfwLevel.R) })
    ).toBeNull();
  });

  it('🔴 an X listing still publishes its X icon', () => {
    expect(registryIconUrl({ contentRating: 'x', icon: icon('icons/x-own-c3', NsfwLevel.X) })).toBe(
      listingIconUrl({ url: 'icons/x-own-c3' })
    );
  });

  it('🔴 an icon re-rated above its listing after go-live stops being published', () => {
    const before = registryIconUrl({
      contentRating: 'pg13',
      icon: icon('icons/rerated-d4', NsfwLevel.PG13),
    });
    const after = registryIconUrl({
      contentRating: 'pg13',
      icon: icon('icons/rerated-d4', NsfwLevel.R),
    });
    expect([before === null, after]).toEqual([false, null]);
  });

  it('a flagged or missing icon publishes nothing, whatever the rating', () => {
    expect(
      registryIconUrl({
        contentRating: 'x',
        icon: { ...icon('icons/flag-e5', NsfwLevel.PG), poi: true },
      })
    ).toBeNull();
    expect(registryIconUrl({ contentRating: 'x', icon: null })).toBeNull();
  });
});
