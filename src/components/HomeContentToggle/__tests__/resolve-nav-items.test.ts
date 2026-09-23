import { describe, expect, it } from 'vitest';
import type { NavGateContext, NavRegistryEntry } from '~/components/HomeContentToggle/nav-registry';
import type { NavConfig } from '~/components/HomeContentToggle/resolve-nav-items';
import {
  resolveNavItems,
  resolveNavLayout,
} from '~/components/HomeContentToggle/resolve-nav-items';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

const ctx = (gated: string[] = []): NavGateContext =>
  ({ features: {} as FeatureAccess, isAuthed: true, gated } as unknown as NavGateContext);

const entry = (key: string, extra: Partial<NavRegistryEntry> = {}): NavRegistryEntry =>
  ({
    key,
    url: `/${key}`,
    defaultGroup: 'bar',
    visible: (c: NavGateContext) =>
      !((c as unknown as { gated: string[] }).gated ?? []).includes(key),
    ...extra,
  } as NavRegistryEntry);

const config = (over: Partial<NavConfig> = {}): NavConfig => ({
  bar: [],
  more: [],
  hidden: [],
  ...over,
});

const keys = (entries: NavRegistryEntry[]) => entries.map((e) => e.key);

describe('resolveNavItems', () => {
  const ABC = [entry('a'), entry('b'), entry('c')];

  it('with no config, places every item in its default group', () => {
    const registry = [entry('a'), entry('b', { defaultGroup: 'more' }), entry('c')];
    const resolved = resolveNavItems(registry, ctx());
    expect(keys(resolved.bar)).toEqual(['a', 'c']);
    expect(keys(resolved.more)).toEqual(['b']);
  });

  /**
   * Kills "return the registry order, ignore the config". Nothing else here specifies a config
   * whose ORDER differs from the registry's, which is the whole point of the feature — an
   * implementation that ignored the saved order passed every case an earlier version of this
   * suite had.
   */
  it("preserves the user's order when it differs from the registry's", () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['c', 'b', 'a'] }));
    expect(keys(resolved.bar)).toEqual(['c', 'b', 'a']);
  });

  /**
   * Kills the preceding/following anchor swap: the two rules give DIFFERENT arrays here —
   * preceding → [c,a,b], following → [b,c,a].
   */
  it('anchors an unseen item after its nearest PRECEDING placed sibling', () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['c', 'a'] }));
    expect(keys(resolved.bar)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to the nearest FOLLOWING sibling when nothing precedes it', () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['c'] }));
    expect(keys(resolved.bar)).toEqual(['a', 'b', 'c']);
  });

  it('anchors within the TARGET group, ignoring neighbours the user moved elsewhere', () => {
    // `b` defaults to `more`; its registry neighbours `a` and `c` are both in `bar`, so neither
    // can anchor it. A rule that ignored the group would place it beside one of them.
    const registry = [entry('a'), entry('b', { defaultGroup: 'more' }), entry('c')];
    const resolved = resolveNavItems(registry, ctx(), config({ bar: ['c', 'a'], more: [] }));
    expect(keys(resolved.bar)).toEqual(['c', 'a']);
    expect(keys(resolved.more)).toEqual(['b']);
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

  it('drops an item the viewer cannot see even when they placed it', () => {
    const resolved = resolveNavItems(ABC, ctx(['b']), config({ bar: ['a', 'b', 'c'] }));
    expect(keys(resolved.bar)).toEqual(['a', 'c']);
  });

  /**
   * Visibility is orthogonal to group membership: a switched-off item keeps its slot so that
   * switching it back on returns it where the user left it, rather than at the end.
   */
  it('hides an item without moving it out of its group', () => {
    // The saved order is REVERSED from the registry's on purpose. With the registry order, an
    // implementation that dropped a hidden key from its group would re-anchor it into the same
    // slot and this would pass either way — which it did, until a mutant survived it.
    const cfg = config({ bar: ['c', 'b', 'a'], hidden: ['b'] });
    expect(keys(resolveNavItems(ABC, ctx(), cfg).bar)).toEqual(['c', 'a']);

    const { groups, hidden } = resolveNavLayout(ABC, cfg);
    expect(groups.bar).toEqual(['c', 'b', 'a']);
    expect([...hidden]).toEqual(['b']);
  });

  it('resolves an all-empty config to the defaults, same as no config', () => {
    expect(keys(resolveNavItems(ABC, ctx(), config()).bar)).toEqual(
      keys(resolveNavItems(ABC, ctx()).bar)
    );
  });

  it('drops a saved key the registry no longer has', () => {
    const cfg = config({ bar: ['a', 'retired', 'b', 'c'] });
    expect(keys(resolveNavItems(ABC, ctx(), cfg).bar)).toEqual(['a', 'b', 'c']);
    // On the LAYOUT, not just the resolved nav: `resolveNavItems` filters unresolvable keys again
    // on the way out, so the resolver assertion above passes even with the guard deleted. The
    // modal reads `resolveNavLayout` directly — a dead key there becomes a row with no registry
    // entry, whose icon lookup is `undefined`, and `rowsToConfig` writes it straight back.
    expect(resolveNavLayout(ABC, cfg).groups.bar).toEqual(['a', 'b', 'c']);
  });

  it('emits a key at most once when the config lists it in both groups', () => {
    const resolved = resolveNavItems(ABC, ctx(), config({ bar: ['a', 'b'], more: ['b', 'c'] }));
    expect(keys(resolved.bar)).toEqual(['a', 'b']);
    expect(keys(resolved.more)).toEqual(['c']);
  });

  it.each([
    ['no config', undefined],
    ['a partial config', config({ bar: ['c'], more: ['a'] })],
    ['a config with a dead key', config({ bar: ['a', 'gone'], more: ['b'] })],
  ])('emits no duplicates across groups — %s', (_label, cfg) => {
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

describe('resolveNavItems — locked items', () => {
  const registry = [entry('home', { locked: true }), entry('a'), entry('b')];

  it('keeps a locked item in its default group whatever the config says', () => {
    const resolved = resolveNavItems(
      registry,
      ctx(),
      config({ bar: ['a', 'b'], more: ['home'], hidden: ['home'] })
    );
    expect(keys(resolved.bar)).toEqual(['home', 'a', 'b']);
    expect(keys(resolved.more)).toEqual([]);
  });

  /**
   * The saved order is REVERSED from the registry's, which the case above cannot see: with the
   * registry order the anchoring pass happens to land a locked item on index 0 anyway, so it
   * passed while `home` was in fact being placed next to whichever item the user had moved.
   */
  it('holds its position when the user reorders everything around it', () => {
    const resolved = resolveNavItems(registry, ctx(), config({ bar: ['b', 'a'] }));
    expect(keys(resolved.bar)).toEqual(['home', 'b', 'a']);
  });

  it('cannot be hidden', () => {
    const { hidden } = resolveNavLayout(registry, config({ hidden: ['home', 'a'] }));
    expect(hidden.has('home')).toBe(false);
    expect(hidden.has('a')).toBe(true);
  });
});

describe('resolveNavItems — defaultHidden', () => {
  const registry = [
    entry('home'),
    entry('posts', { defaultHidden: true }),
    entry('events', { defaultHidden: true }),
  ];

  it('switches a defaultHidden item off without removing it from its group', () => {
    expect(keys(resolveNavItems(registry, ctx()).bar)).toEqual(['home']);
    expect(resolveNavLayout(registry).groups.bar).toEqual(['home', 'posts', 'events']);
  });

  it('honours a user who switched one back on', () => {
    const resolved = resolveNavItems(
      registry,
      ctx(),
      config({ bar: ['home', 'posts', 'events'], hidden: ['events'] })
    );
    expect(keys(resolved.bar)).toEqual(['home', 'posts']);
  });
});
