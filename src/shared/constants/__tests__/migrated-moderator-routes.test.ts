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

  it('strips only the query, not a real sub-path', () => {
    // `images/123` is a migrated sub-path; the strip must take `?tab=x` and
    // leave the `/123`. Asserting a bare key here instead would have been
    // inert — a path with no `?` in it cannot observe the strip at all.
    expect(isMigratedModeratorHref('/moderator/images/123?tab=x')).toBe(true);
  });

  it('does not invent a migration for a route that has not moved', () => {
    // Not a check on the strip — `creator-shop` is in no branch of the map, so
    // this is false with the strip and without it. It is here as a tripwire for
    // the day creator-shop migrates, because on that day BOTH of its nav
    // entries have to flip together and the query-carrying one is the one that
    // would otherwise be missed.
    expect(isMigratedModeratorHref('/moderator/creator-shop')).toBe(false);
    expect(isMigratedModeratorHref('/moderator/creator-shop?type=sticker')).toBe(false);
  });

  it('preserves query and sub-path when RESOLVING, which is a different job', () => {
    // 🔴 The strip belongs in the href check ONLY. Pushed down into the
    // resolver it would silently drop the pre-filtering off a redirect — which
    // is what makes the query-carrying nav entry worth having.
    //
    // The input has to contain a `?` for this to observe that mutation: an
    // input without one is identical before and after the strip, so a bare
    // `resolveMigratedRoute('image-tags')` assertion pinned nothing.
    expect(resolveMigratedRoute('images/123?tab=x')).toBe('images/123?tab=x');
    expect(resolveMigratedRoute('image-tags')).toBe('images/tags');
  });
});
