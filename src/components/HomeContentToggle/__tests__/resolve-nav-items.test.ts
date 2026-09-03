import { describe, expect, it } from 'vitest';
import type { NavGateContext, NavRegistryEntry } from '~/components/HomeContentToggle/nav-registry';
import type { NavConfig } from '~/components/HomeContentToggle/resolve-nav-items';
import { resolveNavItems } from '~/components/HomeContentToggle/resolve-nav-items';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

const ctx = (gated: string[] = []): NavGateContext => ({
  features: {} as FeatureAccess,
  isAuthed: true,
  // `gated` names keys the viewer CANNOT see; the registry entries below read it.
  ...({ gated } as object),
});

const entry = (
  key: string,
  defaultPlacement: NavRegistryEntry['defaultPlacement'] = 'bar'
): NavRegistryEntry => ({
  key,
  url: `/${key}`,
  defaultPlacement,
  visible: (c) => !((c as unknown as { gated: string[] }).gated ?? []).includes(key),
});

const config = (over: Partial<NavConfig> = {}): NavConfig => ({
  bar: [],
  more: [],
  hidden: [],
  ...over,
});

const keys = (entries: NavRegistryEntry[]) => entries.map((e) => e.key);

describe('resolveNavItems', () => {
  const ABC = [entry('a'), entry('b'), entry('c')];

  it('with no config, places every item at its default', () => {
    const registry = [entry('a'), entry('b', 'more'), entry('c', 'hidden')];
    const resolved = resolveNavItems(registry, ctx());
    expect(keys(resolved.bar)).toEqual(['a']);
    expect(keys(resolved.more)).toEqual(['b']);
  });

  /**
   * Kills "return the registry order, ignore the config". Nothing else here specifies a config
   * whose ORDER differs from the registry's, which is the whole point of the feature — an
   * implementation that ignored the saved order passed every case this suite originally had.
   */
  it("preserves the user's order when it differs from the registry's", () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['c', 'b', 'a'] }));
    expect(keys(resolved.bar)).toEqual(['c', 'b', 'a']);
  });

  /**
   * Kills the preceding/following anchor swap. The two rules give DIFFERENT arrays here, which is
   * what makes it a discriminator: preceding → [c,a,b], following → [b,c,a].
   */
  it('anchors an unseen item after its nearest PRECEDING placed sibling', () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['c', 'a'] }));
    expect(keys(resolved.bar)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to the nearest FOLLOWING sibling when nothing precedes it', () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['c'] }));
    expect(keys(resolved.bar)).toEqual(['a', 'b', 'c']);
  });

  /**
   * Kills "apply gates before the merge instead of after". A gated item still occupies its slot
   * during anchoring and is dropped at the end, so it can act as an anchor. Gates-first yields
   * [a,n,b] here; gates-last yields [n,b,a].
   */
  it('lets a gated item anchor a neighbour before it is dropped', () => {
    const registry = [entry('a'), entry('x'), entry('n'), entry('b')];
    const resolved = resolveNavItems(registry, ctx(['x']), config({ bar: ['x', 'a'] }));
    expect(keys(resolved.bar)).toEqual(['n', 'b', 'a']);
  });

  it('drops an item the viewer cannot see even when they pinned it', () => {
    const resolved = resolveNavItems(ABC, ctx(['b']), config({ bar: ['a', 'b', 'c'] }));
    expect(keys(resolved.bar)).toEqual(['a', 'c']);
  });

  it('distinguishes a hide-everything config from no config at all', () => {
    const emptied = resolveNavItems(ABC, ctx(), config({ hidden: ['a', 'b', 'c'] }));
    expect(keys(emptied.bar)).toEqual([]);
    expect(keys(emptied.more)).toEqual([]);

    const absent = resolveNavItems(ABC, ctx());
    expect(keys(absent.bar)).toEqual(['a', 'b', 'c']);
  });

  /**
   * A config whose three zones are ALL empty places nothing, so every item anchors at its default
   * — the same answer as no config. Deliberate, and pinned so it is not "fixed" into a special
   * case: hiding everything writes the keys into `hidden` (the test above), and a reset deletes
   * the key entirely, so all-empty is only reachable from a malformed write. Defaults are the
   * right answer for one of those.
   */
  it('resolves an all-empty config to the defaults, same as no config', () => {
    const allEmpty = resolveNavItems(ABC, ctx(), config());
    expect(keys(allEmpty.bar)).toEqual(keys(resolveNavItems(ABC, ctx()).bar));
    expect(keys(allEmpty.bar)).toEqual(['a', 'b', 'c']);
  });

  /** Kills "defaultPlacement wins over the saved placement". Both directions. */
  it("honours a saved placement that contradicts the item's default", () => {
    const registry = [entry('a', 'bar'), entry('b', 'hidden')];
    const resolved = resolveNavItems(registry, ctx(), config({ more: ['a'], bar: ['b'] }));
    expect(keys(resolved.bar)).toEqual(['b']);
    expect(keys(resolved.more)).toEqual(['a']);
  });

  it('drops a saved key the registry no longer has', () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['a', 'retired', 'b', 'c'] }));
    expect(keys(resolved.bar)).toEqual(['a', 'b', 'c']);
  });

  it('emits a key at most once when the config lists it in two zones', () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['a', 'b'], more: ['b', 'c'] }));
    expect(keys(resolved.bar)).toEqual(['a', 'b']);
    expect(keys(resolved.more)).toEqual(['c']);
  });

  it.each([
    ['no config', undefined],
    ['a partial config', config({ bar: ['c'], more: ['a'] })],
    ['a config with a dead key', config({ bar: ['a', 'gone'], more: ['b'] })],
  ])('emits no duplicates across zones — %s', (_label, cfg) => {
    const resolved = resolveNavItems(ABC, ctx(), cfg);
    const all = [...keys(resolved.bar), ...keys(resolved.more)];
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * A pure synchronous spin is invisible to `testTimeout`, which is `setTimeout`-based — the run
   * would hang until the job is killed rather than fail. This bounds it into a named assertion.
   */
  it('terminates, emitting no more items than the registry holds', () => {
    const registry = Array.from({ length: 50 }, (_, i) => entry(`k${i}`));
    const resolved = resolveNavItems(registry, ctx());
    expect(resolved.bar.length + resolved.more.length).toBeLessThanOrEqual(registry.length);
    expect(resolved.bar.length).toBe(50);
  });

  it('defaults showLabels to true and honours an explicit false', () => {
    expect(resolveNavItems(ABC, ctx()).showLabels).toBe(true);
    expect(resolveNavItems(ABC, ctx(), config({ showLabels: false })).showLabels).toBe(false);
  });
});

describe('resolveNavItems — retired nav-flag seed', () => {
  const registry = [entry('home'), entry('posts', 'hidden'), entry('events', 'hidden')];

  /**
   * 🔴 The discriminating fixture: the RESOLVED flag is false while the STORED settings value is
   * true. After `postsNavItem` stops being `toggleable`, `computeUserFeatureFlagsOverlay` filters
   * the stored value out of the resolved flags — so a resolver seeding from `FeatureAccess` hides
   * Posts from exactly the users who turned it on. If both sources carried the same value this
   * test would pass under either implementation and prove nothing.
   */
  it('seeds from the STORED flag, not the resolved one', () => {
    const resolved = resolveNavItems(registry, ctx(), undefined, { postsNavItem: true });
    expect(keys(resolved.bar)).toEqual(['home', 'posts']);
  });

  it('leaves posts hidden when the stored flag was never set', () => {
    expect(keys(resolveNavItems(registry, ctx()).bar)).toEqual(['home']);
  });

  /**
   * The seed is keyed per ITEM, not on the config object. Keying it on "no config at all" loses
   * Posts permanently for a user who had the flag on and then saved any config, because the
   * account switch is gone by then.
   */
  it('still seeds when a saved config exists but has no entry for the item', () => {
    const resolved = resolveNavItems(registry, ctx(), config({ bar: ['home'] }), {
      postsNavItem: true,
    });
    expect(keys(resolved.bar)).toEqual(['home', 'posts']);
  });

  it('does not re-seed over a placement the user chose', () => {
    const resolved = resolveNavItems(
      registry,
      ctx(),
      config({ bar: ['home'], hidden: ['posts'] }),
      {
        postsNavItem: true,
      }
    );
    expect(keys(resolved.bar)).toEqual(['home']);
  });
});
