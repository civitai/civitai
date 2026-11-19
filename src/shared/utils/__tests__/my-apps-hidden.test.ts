import { describe, expect, it } from 'vitest';
import {
  HIDDEN_APPS_MAX,
  hiddenAppsOverflow,
  isHiddenFromHome,
  latestUseMs,
  sanitizeHiddenApps,
} from '~/shared/utils/my-apps-hidden';

/**
 * The "Remove from My apps" rule, in isolation: hidden ⇔ a valid hide AND no use strictly
 * after it. The merge-level cases (server vs recents use) are in `appsHomeMerge.test.ts`.
 * Instants are pairwise distinct.
 */
const HIDE = '2026-10-10T11:22:33.000Z';
const HIDE_MS = Date.parse(HIDE);

describe('isHiddenFromHome', () => {
  it('hidden with no known use', () => {
    expect(isHiddenFromHome(HIDE, null)).toBe(true);
  });

  it('hidden when the last use is before the hide', () => {
    expect(isHiddenFromHome(HIDE, HIDE_MS - 86_400_000)).toBe(true);
  });

  it('🔴 the boundary: a use AT the hide time keeps it hidden; strictly later shows it', () => {
    expect(isHiddenFromHome(HIDE, HIDE_MS)).toBe(true);
    expect(isHiddenFromHome(HIDE, HIDE_MS + 1)).toBe(false);
  });

  it('not hidden when there is no hide', () => {
    expect(isHiddenFromHome(undefined, null)).toBe(false);
  });

  it.each([
    ['garbage text', 'not-a-date'],
    ['a number', HIDE_MS],
    ['null', null],
    ['an object', { at: HIDE }],
    ['an empty string', ''],
  ])('an unparseable hiddenAt (%s) never hides', (_l, raw) => {
    expect(isHiddenFromHome(raw, null)).toBe(false);
  });

  it('a non-finite use counts as no use', () => {
    expect(isHiddenFromHome(HIDE, Number.NaN)).toBe(true);
  });
});

describe('latestUseMs', () => {
  it('takes the latest of a Date, epoch ms and a date string; ignores the unparseable', () => {
    const a = new Date('2026-10-03T04:05:06.000Z');
    const b = Date.parse('2026-10-12T19:20:21.000Z');
    const c = '2026-10-07T01:02:03.000Z';
    expect(latestUseMs(a, b, c, null, undefined, 'nope')).toBe(b);
    expect(latestUseMs(a, c)).toBe(Date.parse(c));
    expect(latestUseMs(null, undefined, 'nope')).toBeNull();
  });
});

describe('sanitizeHiddenApps', () => {
  it('keeps well-formed entries, canonicalised to ISO', () => {
    expect(
      sanitizeHiddenApps({
        'pixel-forge': HIDE,
        'tag-wizard': '2026-10-11T00:00:00Z',
      })
    ).toEqual({ 'pixel-forge': HIDE, 'tag-wizard': '2026-10-11T00:00:00.000Z' });
  });

  it('drops garbage entries and a slug past the length bound', () => {
    expect(
      sanitizeHiddenApps({
        ok: HIDE,
        bad: 'soon',
        num: 5,
        [`${'x'.repeat(65)}`]: HIDE,
      })
    ).toEqual({ ok: HIDE });
  });

  it.each([null, undefined, 'str', 7, [HIDE]])('a non-object (%s) reads as no hides', (raw) => {
    expect(sanitizeHiddenApps(raw)).toEqual({});
  });
});

describe('hiddenAppsOverflow — the cap', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12, 0, 0)).toISOString();

  it('nothing to drop at or under the cap', () => {
    expect(hiddenAppsOverflow({ a: at(1), b: at(2) }, 2)).toEqual([]);
  });

  it('🔴 drops the OLDEST past the cap — not the newest, not insertion order', () => {
    // Insertion order deliberately differs from age order.
    const map = { newest: at(20), oldest: at(3), middle: at(9), older: at(5) };
    expect(hiddenAppsOverflow(map, 2)).toEqual(['oldest', 'older']);
  });

  it('a garbage value is dropped before any real hide', () => {
    expect(hiddenAppsOverflow({ real: at(1), junk: 'x', newer: at(2) }, 2)).toEqual(['junk']);
  });

  it('defaults to HIDDEN_APPS_MAX', () => {
    const map = Object.fromEntries(
      Array.from({ length: HIDDEN_APPS_MAX + 1 }, (_, i) => [
        `app-${i}`,
        new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      ])
    );
    expect(hiddenAppsOverflow(map)).toEqual(['app-0']);
    delete map['app-0'];
    expect(hiddenAppsOverflow(map)).toEqual([]);
  });
});
