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
      'apps',
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

/**
 * The `apps` pill's gate is the `/apps` page's own SSR gate (`hasAppsStoreAccess`) restated
 * as a viewer fact. The all-on/all-off vectors above cannot tell its three disjuncts apart,
 * so these isolate each one: a re-inline to `!!features.appBlocks` (the exact historical
 * defect this class of gate shipped, #3907) leaves the whole default-layout suite above
 * green while the external-only and listings-only vectors here go red.
 */
describe('the apps pill gate', () => {
  /** A feature vector answering true ONLY for the named flags, false for everything else. */
  const onlyFlags = (...names: string[]): FeatureAccess =>
    new Proxy({} as FeatureAccess, {
      get: (_target, key) => (names as readonly string[]).includes(key as string),
    }) as FeatureAccess;

  it('shows the pill for the EXTERNAL-ONLY cohort (appListingsPublicExternal alone)', () => {
    const { bar, more } = resolve(onlyFlags('appListingsPublicExternal'));
    // Every OTHER gated item is hidden on this vector (`shop`'s own `cosmeticShop` gate
    // among them), so the pill's presence here rides on NOTHING but its own gate —
    // exactly the discrimination the all-on vector cannot make.
    expect(bar.map((e) => e.key)).toEqual([
      'home',
      'models',
      'images',
      'videos',
      'apps',
      'updates',
    ]);
    expect(more).toEqual([]);
  });

  it.each([
    ['appListings'],
    ['appBlocks'],
  ])('shows the pill when %s alone is on', (flag) => {
    const { bar } = resolve(onlyFlags(flag));
    expect(bar.some((e) => e.key === 'apps')).toBe(true);
  });

  it('shows the pill for a signed-OUT store-flag holder — the gate is flags, not auth', () => {
    // Every OTHER vector passes isAuthed: true, so the mutant
    // `hasAppsStoreAccess(features) && ctx.isAuthed` survives the rest of the battery.
    // /apps itself is anon-capable behind the flag (`resolveAppsPageAccess` F-E E1),
    // so a signed-OUT holder must keep the pill the day a segment widens to anon.
    const { bar } = resolveNavItems(navRegistry, {
      features: onlyFlags('appListings'),
      isAuthed: false,
    });
    expect(bar.some((e) => e.key === 'apps')).toBe(true);
  });

  it('drops a PINNED pill once the viewer loses store access — gates run last over the config', () => {
    const { bar } = resolveNavItems(
      navRegistry,
      { features: onlyFlags(), isAuthed: true },
      { bar: ['home', 'apps', 'models'], more: [], hidden: [] }
    );
    // `images`, `videos` and `updates` carry no gate, so they render on this vector too;
    // `apps` is the one that disappears.
    //
    // `updates` SURFACES at index 1 — where the dropped `apps` was pinned — and that is the
    // anchoring rule doing its job, not a stray: an unplaced key anchors beside its REGISTRY
    // neighbour, so moving `apps` earlier in the registry drags the keys that follow it into
    // that slot too.
    //
    // 🔴 `updates` is NOT the key that anchors there — `events` is, because it is `apps`'s
    // actual registry successor. `events` is `defaultHidden`, so it is filtered out of the
    // rendered bar and `updates` is simply the first key behind it that survives. Do not read
    // this vector as "`apps`'s neighbour takes its place": a `defaultHidden` entry can be the
    // direct anchor and silently pass the slot along to ITS follower, which is the non-obvious
    // part and the only reason this array moved the way it did.
    //
    // The durable point: a registry REORDER changes the surviving ORDER here, not just which
    // key vanishes — which is exactly what this vector exists to pin.
    expect(bar.map((e) => e.key)).toEqual(['home', 'updates', 'models', 'images', 'videos']);
  });
});
