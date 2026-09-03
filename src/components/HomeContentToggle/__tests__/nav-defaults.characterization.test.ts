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
 * ⚠️ This is a snapshot of NEW behaviour, not a re-approval of old. No test covered
 * `filterHomeOptions` on `main` — there was nothing to diff against, and the draft that did run
 * against it was never committed, so a reader cannot check it. What WAS verified by hand against
 * `origin/main`'s `filterHomeOptions`: the all-flags-off vector is unchanged, and of the five
 * items that were `grouped` there (`posts`, `bounties`, `challenges`, `events`, `updates`) only
 * `bounties` became `more`.
 */

const allFlags = (value: boolean) =>
  new Proxy({} as FeatureAccess, { get: () => value }) as FeatureAccess;

const resolve = (features: FeatureAccess) =>
  resolveNavItems(navRegistry, { features, isAuthed: true });

describe('sub-nav default layout', () => {
  it('places every gate-passing item at its default with all flags on', () => {
    const { bar, more } = resolve(allFlags(true));

    // `bounties` is the one item defaulting to More. It was one of five `grouped` items, all of
    // which showed as pills above `xl` before placement stopped depending on viewport width.
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
   * `posts` and `events` are absent because they default to `hidden`, not because a gate hides
   * them — they carry no gate at all now, so the modal can offer them to everyone. This matches
   * what a user who never touched account settings has always seen. The flags that used to
   * surface them are deleted in this change; anyone who had them on re-adds them from the modal.
   *
   * The four promoted user-menu destinations (leaderboard, auctions, vault, collections)
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
});
