import { describe, expect, it } from 'vitest';
import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import { seedRows } from '~/components/HomeContentToggle/nav-rows';
import { resolveNavItems } from '~/components/HomeContentToggle/resolve-nav-items';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

/**
 * These pin the SEAM between the settings modal and the nav, not either one on its own.
 *
 * The defect this exists for passed every function-level test: the modal carried its own merge
 * that skipped the retired-flag seed, so a user with Posts in their bar was shown Posts as Hidden
 * and lost it on their next Save — with the account switch already retired. Both halves were
 * individually correct. Only their disagreement was wrong.
 */

const allOn = new Proxy({} as FeatureAccess, { get: () => true }) as FeatureAccess;
const ctx = { features: allOn, isAuthed: true };

const zoneOf = (rows: ReturnType<typeof seedRows>, key: string) =>
  rows.find((row) => row.key === key)?.placement;

describe('settings modal rows agree with the rendered nav', () => {
  it.each([
    ['no settings at all', undefined],
    ['a user who had Posts switched on', { features: { postsNavItem: true } }],
    ['a user who had Events switched on', { features: { eventsNavItem: true } }],
    [
      'a saved config',
      { navigation: { bar: ['models', 'home'], more: ['shop'], hidden: ['videos'] } },
    ],
    [
      'a saved config from before an item existed',
      { navigation: { bar: ['home', 'models'], more: [], hidden: [] } },
    ],
  ])('%s', (_label, settings) => {
    const rows = seedRows(settings as UserContentSettings | undefined);
    const nav = resolveNavItems(
      navRegistry,
      ctx,
      (settings as UserContentSettings | undefined)?.navigation,
      {
        postsNavItem: (settings as UserContentSettings | undefined)?.features?.postsNavItem,
        eventsNavItem: (settings as UserContentSettings | undefined)?.features?.eventsNavItem,
      }
    );

    expect(rows.filter((r) => r.placement === 'bar').map((r) => r.key)).toEqual(
      nav.bar.map((e) => e.key)
    );
    expect(rows.filter((r) => r.placement === 'more').map((r) => r.key)).toEqual(
      nav.more.map((e) => e.key)
    );
  });

  /**
   * The specific loss. Reverting the modal to its own merge puts `posts` in `hidden` here while
   * the nav still renders it in `bar` — a legible disagreement naming the wrong zone, not a hang.
   */
  it('offers Posts in the bar for a user who had the flag on, matching what their nav shows', () => {
    const settings = { features: { postsNavItem: true } } as UserContentSettings;
    expect(zoneOf(seedRows(settings), 'posts')).toBe('bar');
    expect(
      resolveNavItems(navRegistry, ctx, undefined, { postsNavItem: true }).bar.map((e) => e.key)
    ).toContain('posts');
  });

  /**
   * The other half of the retirement: with the account switches gone, the modal is the ONLY way
   * to reach Posts and Events. Gating those rows on the flags they replaced made them
   * unreachable for the default-off majority while `NavTidyNotice` told that exact audience they
   * could turn them back on from here.
   */
  it('keeps Posts and Events ungated, because the modal is now their only route back', () => {
    // Re-adding `visible: (ctx) => ctx.features.postsNavItem` here filters the row out of the
    // modal for the default-off majority — and `NavTidyNotice` points that exact audience at the
    // modal saying they can put Posts back. The account switch that used to set the flag is gone.
    for (const key of ['posts', 'events'] as const)
      expect(navRegistry.find((entry) => entry.key === key)?.visible).toBeUndefined();
  });

  it('offers Posts and Events to a user whose flags were never set', () => {
    const rows = seedRows(undefined);
    expect(zoneOf(rows, 'posts')).toBe('hidden');
    expect(zoneOf(rows, 'events')).toBe('hidden');

    const registryKeys = navRegistry.map((e) => e.key);
    expect(rows.map((r) => r.key).sort()).toEqual([...registryKeys].sort());
  });

  /**
   * Negative control for the assertion above: this is what the modal produces from a
   * still-loading settings query. It is identical to the resolved-but-empty case, which is
   * exactly why the modal must not seed from it — the call site waits for `isResolved` instead.
   */
  it('produces the pure defaults from an empty settings object, indistinguishable from loading', () => {
    expect(seedRows({} as UserContentSettings)).toEqual(seedRows(undefined));
  });
});
