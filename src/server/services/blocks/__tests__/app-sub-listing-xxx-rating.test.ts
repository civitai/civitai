import { describe, expect, it, vi } from 'vitest';

/**
 * Content levels, build 3: an App Store ITEM card rated XXX is `xxx`, never `x`, and every gate
 * that reads a card rating treats it as its own mature rating. Before this, an XXX item's card read
 * `x`, so a viewer whose browsing level admits X but not XXX was shown it, and so was the SFW host
 * through any check that took the rating at face value.
 *
 * Levels are NsfwLevel bits (PG 1, PG-13 2, R 4, X 8, XXX 16, Blocked 32).
 */

// `server-domain.ts` builds its host map from the environment at import: a SFW primary and a
// red-capable host, as production has them.
vi.stubEnv('SERVER_DOMAIN_GREEN', 'civitai.green');
vi.stubEnv('SERVER_DOMAIN_GREEN_ALIASES', '');
vi.stubEnv('SERVER_DOMAIN_BLUE', 'civitai.com');
vi.stubEnv('SERVER_DOMAIN_BLUE_ALIASES', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED_ALIASES', '');

const SFW_HOST = 'civitai.com';
const RED_HOST = 'civitai.red';

describe('an item’s level → its card rating', () => {
  it.each([
    [1, 'g'],
    [2, 'pg13'],
    [4, 'r'],
    [8, 'x'],
    [16, 'xxx'],
    // Blocked has no card (it is hidden); were it asked, it fails closed to the top rung.
    [32, 'xxx'],
  ])('level %i → %s', async (level, rating) => {
    const { subListingRatingFromNsfwLevel } = await import(
      '~/shared/constants/app-sub-listing.constants'
    );
    expect(subListingRatingFromNsfwLevel(level)).toBe(rating);
  });

  it('xxx sits above x on the card ladder: the stricter of parent and child wins', async () => {
    const { effectiveSubListingRating, isRatingAtLeastAsStrict, APP_SUB_LISTING_CONTENT_RATINGS } =
      await import('~/shared/constants/app-sub-listing.constants');
    expect([...APP_SUB_LISTING_CONTENT_RATINGS]).toEqual(['g', 'pg', 'pg13', 'r', 'x', 'xxx']);
    expect(effectiveSubListingRating('x', 'xxx')).toBe('xxx');
    expect(effectiveSubListingRating('xxx', 'r')).toBe('xxx');
    expect(effectiveSubListingRating(null, 'xxx')).toBe('xxx');
    expect(isRatingAtLeastAsStrict('x', 'xxx')).toBe(false);
    expect(isRatingAtLeastAsStrict('xxx', 'x')).toBe(true);
  });
});

describe('🔴 the per-viewer gate tells xxx from x', () => {
  it.each<[number, boolean, boolean]>([
    // X but not XXX: an X card is shown, an XXX one is not.
    [1 | 2 | 4 | 8, true, false],
    // XXX but not X: the reverse.
    [1 | 2 | 16, false, true],
    // Both.
    [1 | 2 | 4 | 8 | 16, true, true],
  ])('a red-host viewer at level %i: x shown=%s, xxx shown=%s', async (level, x, xxx) => {
    const { matureRatingAllowed, matureRatingsAllowed } = await import(
      '~/server/services/blocks/app-listing-store-gate'
    );
    const allowed = matureRatingsAllowed(true, level);
    expect(matureRatingAllowed('x', allowed)).toBe(x);
    expect(matureRatingAllowed('xxx', allowed)).toBe(xxx);
    expect(matureRatingAllowed('XXX', allowed)).toBe(xxx);
  });

  it('off a red-capable host nothing mature is allowed, xxx included', async () => {
    const { matureRatingAllowed, matureRatingsAllowed } = await import(
      '~/server/services/blocks/app-listing-store-gate'
    );
    const allowed = matureRatingsAllowed(false, 1 | 2 | 4 | 8 | 16);
    expect(allowed).toEqual({ r: false, x: false, xxx: false });
    expect(matureRatingAllowed('xxx', allowed)).toBe(false);
  });

  it('the store’s item-card filter hides xxx unless the viewer’s level includes XXX', async () => {
    const { subListingMatureFilter, listingMatureFilter } = await import(
      '~/server/services/blocks/app-listing.service'
    );
    const text = (allowed: { r: boolean; x: boolean; xxx: boolean }) =>
      subListingMatureFilter(allowed).sql.replace(/\s+/g, ' ');
    expect(text({ r: true, x: true, xxx: false })).toBe(
      "(TRUE) AND COALESCE(LOWER(s.content_rating), '') <> 'xxx'"
    );
    expect(text({ r: true, x: true, xxx: true })).toBe('TRUE');
    expect(text({ r: false, x: false, xxx: false })).toBe(
      "(COALESCE(LOWER(s.content_rating), '') NOT IN ('r', 'x')) AND COALESCE(LOWER(s.content_rating), '') <> 'xxx'"
    );
    expect(text({ r: true, x: false, xxx: true })).toBe(
      "COALESCE(LOWER(s.content_rating), '') <> 'x'"
    );
    // An app (listing) is never rated xxx: its filter is unchanged.
    expect(listingMatureFilter({ r: true, x: true, xxx: false }).sql).toBe('TRUE');
  });

  it('a registry audience never admits xxx: it cannot say whether its user does', async () => {
    const { audienceForUser } = await import('~/server/registry-adapter/audience');
    const audience = audienceForUser({ showNsfw: true, browsingLevel: 1 | 2 | 4 | 8 | 16 });
    expect(audience.allowed.xxx).toBe(false);
  });
});

describe('🔴 xxx is a mature rating on every host check', () => {
  it('refused on the SFW host, allowed on the red-capable one', async () => {
    const { isMatureContentRating, ratingAllowedOnHost } = await import(
      '~/server/utils/server-domain'
    );
    expect(isMatureContentRating('xxx')).toBe(true);
    expect(ratingAllowedOnHost('xxx', SFW_HOST)).toBe(false);
    expect(ratingAllowedOnHost('xxx', RED_HOST)).toBe(true);
    // Control: the same host admits an SFW rating, so the refusal is the rating's.
    expect(ratingAllowedOnHost('pg13', SFW_HOST)).toBe(true);
  });
});
