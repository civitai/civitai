import { describe, expect, it } from 'vitest';
import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import { matchesDefaults, rowsToConfig, seedRows } from '~/components/HomeContentToggle/nav-rows';
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

const settingsOf = (s?: object) => s as UserContentSettings | undefined;

const CASES: [string, object | undefined][] = [
  ['no settings at all', undefined],
  [
    'a saved config',
    { navigation: { bar: ['home', 'models'], more: ['shop'], hidden: ['videos'] } },
  ],
  [
    'a saved config from before an item existed',
    { navigation: { bar: ['home', 'models'], more: [], hidden: [] } },
  ],
];

describe('settings modal rows agree with the rendered nav', () => {
  it.each(CASES)('%s', (_label, raw) => {
    const settings = settingsOf(raw);
    const rows = seedRows(settings);
    const nav = resolveNavItems(navRegistry, ctx, settings?.navigation);

    for (const group of ['bar', 'more'] as const)
      expect(rows.filter((r) => r.group === group && !r.hidden).map((r) => r.key)).toEqual(
        nav[group].map((e) => e.key)
      );
  });

  /**
   * The modal is the ONLY way to reach Posts and Events now that their feature flags are deleted.
   * Gating those rows on anything would make them unreachable.
   */
  it('keeps Posts and Events ungated, because the modal is now their only route back', () => {
    for (const key of ['posts', 'events'] as const)
      expect(navRegistry.find((entry) => entry.key === key)?.visible).toBeUndefined();
  });

  it('offers every registry item as a row, switched off where it defaults to hidden', () => {
    const rows = seedRows(undefined);
    expect(rows.map((r) => r.key).sort()).toEqual(navRegistry.map((e) => e.key).sort());
    expect(rows.find((r) => r.key === 'posts')?.hidden).toBe(true);
    expect(rows.find((r) => r.key === 'events')?.hidden).toBe(true);
  });

  it('marks home locked and nothing else', () => {
    const locked = seedRows(undefined).filter((r) => r.locked);
    expect(locked.map((r) => r.key)).toEqual(['home']);
    expect(locked[0].hidden).toBe(false);
  });

  /**
   * Negative control for the assertions above: this is what the modal produces from a
   * still-loading settings query. Identical to the resolved-but-empty case, which is exactly why
   * the modal must not seed from it — the call site waits for `isResolved` instead.
   */
  it('produces the pure defaults from an empty settings object, indistinguishable from loading', () => {
    expect(seedRows(settingsOf({}))).toEqual(seedRows(undefined));
  });

  it('persists the icon-only setting rather than hardcoding it', () => {
    // Nothing else in the suite asserts `showLabels`, so hardcoding it in `rowsToConfig` was
    // green everywhere while "turn labels off" silently never saved.
    const rows = seedRows(undefined);
    expect(rowsToConfig(rows, false).showLabels).toBe(false);
    expect(rowsToConfig(rows, true).showLabels).toBe(true);
  });

  it('writes nothing when the layout is untouched, so a no-op Save costs no bytes', () => {
    expect(matchesDefaults(seedRows(undefined), true)).toBe(true);
    // Icon-only is itself a change, even with every row at its default.
    expect(matchesDefaults(seedRows(undefined), false)).toBe(false);
    const moved = seedRows(undefined).map((r) =>
      r.key === 'shop' ? { ...r, group: 'more' as const } : r
    );
    expect(matchesDefaults(moved, true)).toBe(false);
  });

  /**
   * Save must round-trip: what the modal writes, re-seeded, has to be what it showed. Otherwise
   * opening the modal and saving without touching anything would move things.
   */
  it.each(CASES)('round-trips a save without changing anything — %s', (_label, raw) => {
    const rows = seedRows(settingsOf(raw));
    const saved = rowsToConfig(rows, true);
    expect(seedRows({ navigation: saved } as UserContentSettings)).toEqual(rows);
  });
});
