import { describe, expect, it } from 'vitest';
import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import { resolveNavItems } from '~/components/HomeContentToggle/resolve-nav-items';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

/**
 * The sub nav's DEFAULT layout — what a user who never opens the customization modal sees.
 *
 * Both halves are pinned deliberately. A vector taken only at all-flags-on cannot see a gate that
 * stopped firing, and one taken only at all-off cannot see an item that stopped being gated.
 *
 * Arrays are literal on purpose. Deriving them from `navRegistry` would compare the registry to
 * itself and pin nothing — the point is that changing a `defaultPlacement` has to fail here and be
 * re-approved, because it changes the nav of every user who has not configured one.
 *
 * The pre-refactor version of this file asserted the same two vectors against `filterHomeOptions`,
 * and the three deliberate deltas from it are called out on the assertions below.
 */

const allFlags = (value: boolean) =>
  new Proxy({} as FeatureAccess, { get: () => value }) as FeatureAccess;

const resolve = (features: FeatureAccess, seed?: { postsNavItem?: boolean }) =>
  resolveNavItems(navRegistry, { features, isAuthed: true }, undefined, seed);

describe('sub-nav default layout', () => {
  it('places every gate-passing item at its default with all flags on', () => {
    const { bar, more } = resolve(allFlags(true));

    // DELTA 1: `bounties` is the one item defaulting to More; it was a `grouped` item that showed
    // as a pill above `xl` before placement stopped depending on viewport width.
    expect(bar.map((e) => e.key)).toEqual([
      'home',
      'models',
      'images',
      'videos',
      '3d-models',
      'hubs',
      'articles',
      'comics',
      'challenges',
      'updates',
      'shop',
    ]);
    expect(more.map((e) => e.key)).toEqual(['bounties']);
  });

  /**
   * DELTA 2: `posts` and `events` are absent even with their flags on, because placement and
   * access are now separate. Their flags are `default: false`, so this matches what a user who
   * never touched account settings has always seen; the seed below is what carries the users who
   * DID turn them on.
   *
   * DELTA 3: the four promoted user-menu destinations (leaderboard, auctions, vault, collections)
   * exist in the registry but default to hidden — the sub nav is an additional surface for them,
   * not a move, so they appear only once a user places them.
   */
  it('leaves posts, events and the promoted user-menu items out of the default layout', () => {
    const { bar, more } = resolve(allFlags(true));
    const placed = [...bar, ...more].map((e) => e.key);
    expect(placed).not.toContain('posts');
    expect(placed).not.toContain('events');
    expect(placed).not.toContain('leaderboard');
    expect(placed).not.toContain('auctions');
    expect(placed).not.toContain('vault');
    expect(placed).not.toContain('collections');
  });

  it('leaves only the ungated items with every flag off', () => {
    const { bar, more } = resolve(allFlags(false));
    expect(bar.map((e) => e.key)).toEqual(['home', 'models', 'images', 'videos', 'updates']);
    expect(more).toEqual([]);
  });

  it('seeds posts back into the bar at its registry position for a user who had the flag on', () => {
    const { bar } = resolve(allFlags(true), { postsNavItem: true });
    expect(bar.map((e) => e.key)).toEqual([
      'home',
      'models',
      'images',
      'videos',
      '3d-models',
      'hubs',
      'posts',
      'articles',
      'comics',
      'challenges',
      'updates',
      'shop',
    ]);
  });
});
