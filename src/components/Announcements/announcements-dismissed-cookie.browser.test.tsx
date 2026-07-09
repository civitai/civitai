import { describe, expect, test, beforeEach } from 'vitest';
import {
  ANNOUNCEMENTS_DISMISSED_COOKIE,
  emptyDismissed,
  migrateLegacyLocalStorageToCookie,
  readDismissedCookieClient,
  writeDismissedCookieClient,
} from '~/components/Announcements/announcements-dismissed-cookie';

/**
 * DOM-backed tests for the cookie store — the read/write round-trip and the
 * localStorage→cookie migration, which need a REAL `document.cookie` +
 * `localStorage` (so they live in the browser project, not the node unit suite).
 */

const LEGACY_KEY = 'announcements';

function clearAll() {
  // Expire the dismissed cookie.
  document.cookie = `${ANNOUNCEMENTS_DISMISSED_COOKIE}=; path=/; max-age=-1`;
  window.localStorage.clear();
}

beforeEach(() => {
  clearAll();
});

describe('cookie read/write round-trip', () => {
  test('missing cookie → empty dismissed', () => {
    expect(readDismissedCookieClient()).toEqual(emptyDismissed());
  });

  test('write → read preserves the per-type shape', () => {
    const dismissed = { site: [1, 2], generator: [7], training: [] };
    writeDismissedCookieClient(dismissed);
    expect(readDismissedCookieClient()).toEqual(dismissed);
  });

  test('overwrite replaces the prior value', () => {
    writeDismissedCookieClient({ site: [1], generator: [], training: [] });
    writeDismissedCookieClient({ site: [1, 2], generator: [3], training: [] });
    expect(readDismissedCookieClient()).toEqual({ site: [1, 2], generator: [3], training: [] });
  });
});

describe('migrateLegacyLocalStorageToCookie', () => {
  test('legacy v2 localStorage present, cookie absent → cookie seeded from it, legacy cleared', () => {
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        state: { dismissed: { site: [1, 2], generator: [9], training: [] } },
        version: 2,
      })
    );
    migrateLegacyLocalStorageToCookie();
    // Existing dismissers keep their dismissed set — now in the cookie.
    expect(readDismissedCookieClient()).toEqual({ site: [1, 2], generator: [9], training: [] });
    // Legacy key cleaned up.
    expect(window.localStorage.getItem(LEGACY_KEY)).toBe(null);
  });

  test('legacy v1 flat number[] → migrated into the site bucket', () => {
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ state: { dismissed: [11, 22] }, version: 1 })
    );
    migrateLegacyLocalStorageToCookie();
    expect(readDismissedCookieClient()).toEqual({ site: [11, 22], generator: [], training: [] });
  });

  test('no-op when a cookie already exists (does not clobber current state)', () => {
    writeDismissedCookieClient({ site: [5], generator: [], training: [] });
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ state: { dismissed: { site: [99] } }, version: 2 })
    );
    migrateLegacyLocalStorageToCookie();
    // Cookie wins; legacy is left untouched (only migrated when cookie absent).
    expect(readDismissedCookieClient()).toEqual({ site: [5], generator: [], training: [] });
    expect(window.localStorage.getItem(LEGACY_KEY)).not.toBe(null);
  });

  test('no legacy data and no cookie → stays empty', () => {
    migrateLegacyLocalStorageToCookie();
    expect(readDismissedCookieClient()).toEqual(emptyDismissed());
  });
});
