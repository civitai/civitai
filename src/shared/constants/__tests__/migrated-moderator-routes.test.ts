import { describe, expect, it } from 'vitest';
import {
  isMigratedModeratorHref,
  resolveMigratedRoute,
} from '~/shared/constants/migrated-moderator-routes';

/**
 * The nav marks links that will bounce to the moderator app. Since the nav
 * gained an entry carrying a query string — the same page, pre-filtered — the
 * check has to see past it.
 */
describe('isMigratedModeratorHref ignores query and hash', () => {
  it('scores a migrated route the same with or without a query', () => {
    // `images` is in MIGRATED_ROUTES. Matching the raw href would fail here,
    // and the nav would render a moved page as if it were still local.
    expect(isMigratedModeratorHref('/moderator/images')).toBe(true);
    expect(isMigratedModeratorHref('/moderator/images?tab=pending')).toBe(true);
    expect(isMigratedModeratorHref('/moderator/images#anchor')).toBe(true);
  });

  it('does not invent a migration for a route that has not moved', () => {
    // The pre-filtered sticker link. If creator-shop ever migrates this flips,
    // which is the point — it flips for both of its nav entries at once.
    expect(isMigratedModeratorHref('/moderator/creator-shop')).toBe(false);
    expect(isMigratedModeratorHref('/moderator/creator-shop?type=sticker')).toBe(false);
  });

  it('leaves non-moderator hrefs alone', () => {
    expect(isMigratedModeratorHref('/user/sticker-placements?tab=received')).toBe(false);
  });

  it('still preserves the sub-path when resolving', () => {
    // Guards the stripping from being pushed down into resolveMigratedRoute,
    // where it would eat a real sub-path.
    expect(resolveMigratedRoute('image-tags')).toBe('images/tags');
  });
});
