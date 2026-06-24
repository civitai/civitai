import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearRecentlyOpenedApps,
  getRecentlyOpenedApps,
  MAX_RECENTS,
  recordRecentlyOpenedApp,
  RECENTLY_OPENED_APPS_KEY,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedAppsStore';

/**
 * `recentlyOpenedApps` localStorage helper — runs in browser mode so a REAL
 * `window.localStorage` is present (the helper no-ops on the server, so a node
 * unit test couldn't exercise the cap/dedup/order logic at all).
 *
 * Contract under test (each reverted property fails a case):
 *  - newest-first prepend
 *  - de-dup by id (re-record MOVES to front, no duplicate)
 *  - capped at MAX_RECENTS
 *  - tolerant read of a corrupt store (→ [])
 */

const app = (id: string): RecentApp => ({ id, blockId: `block-${id}` });

beforeEach(() => {
  clearRecentlyOpenedApps();
});

describe('recentlyOpenedApps helper', () => {
  test('empty store reads as []', () => {
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  test('record prepends newest-first', () => {
    recordRecentlyOpenedApp(app('a'));
    recordRecentlyOpenedApp(app('b'));
    recordRecentlyOpenedApp(app('c'));
    expect(getRecentlyOpenedApps().map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  test('re-recording an existing id de-dups and moves it to the front (no duplicate)', () => {
    recordRecentlyOpenedApp(app('a'));
    recordRecentlyOpenedApp(app('b'));
    recordRecentlyOpenedApp(app('a')); // re-open 'a'
    const ids = getRecentlyOpenedApps().map((r) => r.id);
    expect(ids).toEqual(['a', 'b']);
    // exactly one 'a' (deduped)
    expect(ids.filter((x) => x === 'a')).toHaveLength(1);
  });

  test('caps the list at MAX_RECENTS, dropping the oldest', () => {
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      recordRecentlyOpenedApp(app(`app-${i}`));
    }
    const list = getRecentlyOpenedApps();
    expect(list).toHaveLength(MAX_RECENTS);
    // newest (last recorded) is at the front; the first MAX_RECENTS-5 are dropped
    expect(list[0].id).toBe(`app-${MAX_RECENTS + 4}`);
    expect(list.map((r) => r.id)).not.toContain('app-0');
  });

  test('record returns the updated list', () => {
    const next = recordRecentlyOpenedApp(app('x'));
    expect(next.map((r) => r.id)).toEqual(['x']);
  });

  test('a corrupt store value reads as [] (fail-soft)', () => {
    window.localStorage.setItem(RECENTLY_OPENED_APPS_KEY, '{ not valid json');
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  test('malformed entries are dropped on read', () => {
    window.localStorage.setItem(
      RECENTLY_OPENED_APPS_KEY,
      JSON.stringify([{ id: 'ok', blockId: 'b-ok' }, { id: 123 }, null, 'nope'])
    );
    expect(getRecentlyOpenedApps()).toEqual([{ id: 'ok', blockId: 'b-ok' }]);
  });
});
