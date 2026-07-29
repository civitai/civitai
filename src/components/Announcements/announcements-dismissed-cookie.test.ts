import { describe, expect, test } from 'vitest';
import {
  emptyDismissed,
  parseDismissedCookieValue,
  parseLegacyPersisted,
} from '~/components/Announcements/announcements-dismissed-cookie';

/**
 * Unit tests for the cookie-backed dismissed store's PURE layer — the pieces that
 * run identically on the server and the client (so both compute the dismissed set
 * the same way → hydration match). The DOM-backed read/write + migration side
 * effects are covered in the browser test.
 */

describe('parseDismissedCookieValue', () => {
  test('empty / missing / null cookie → empty per-type record', () => {
    for (const raw of [undefined, null, '']) {
      expect(parseDismissedCookieValue(raw)).toEqual(emptyDismissed());
    }
  });

  test('round-trips the per-type shape (write JSON → parse back)', () => {
    const dismissed = { site: [1, 2, 3], generator: [10], training: [] };
    // The client writes via cookies-next (JSON.stringify) and reads the
    // URL-decoded JSON string back, so parse(JSON.stringify(x)) IS the round-trip.
    expect(parseDismissedCookieValue(JSON.stringify(dismissed))).toEqual(dismissed);
  });

  test('fills missing buckets with empty arrays (partial payload)', () => {
    expect(parseDismissedCookieValue(JSON.stringify({ site: [5] }))).toEqual({
      site: [5],
      generator: [],
      training: [],
    });
  });

  test('malformed JSON → empty', () => {
    expect(parseDismissedCookieValue('{not json')).toEqual(emptyDismissed());
  });

  test('non-object / wrong-typed payloads → empty (never throws)', () => {
    expect(parseDismissedCookieValue('42')).toEqual(emptyDismissed());
    expect(parseDismissedCookieValue('"a string"')).toEqual(emptyDismissed());
    expect(parseDismissedCookieValue('[1,2,3]')).toEqual(emptyDismissed());
  });

  test('coerces a non-array bucket to empty rather than throwing', () => {
    expect(
      parseDismissedCookieValue(JSON.stringify({ site: 'nope', generator: [7], training: null }))
    ).toEqual({ site: [], generator: [7], training: [] });
  });
});

describe('parseLegacyPersisted (localStorage → cookie migration source)', () => {
  test('v2 persist envelope (per-type record) is preserved', () => {
    const legacy = JSON.stringify({
      state: { dismissed: { site: [1, 2], generator: [9], training: [] } },
      version: 2,
    });
    expect(parseLegacyPersisted(legacy)).toEqual({
      site: [1, 2],
      generator: [9],
      training: [],
    });
  });

  test('v0/v1 persist envelope (flat number[]) lands in the site bucket', () => {
    const legacy = JSON.stringify({ state: { dismissed: [11, 22] }, version: 1 });
    expect(parseLegacyPersisted(legacy)).toEqual({
      site: [11, 22],
      generator: [],
      training: [],
    });
  });

  test('bare (no persist envelope) record is tolerated', () => {
    expect(parseLegacyPersisted(JSON.stringify({ dismissed: { site: [3] } }))).toEqual({
      site: [3],
      generator: [],
      training: [],
    });
  });

  test('empty / malformed legacy → empty', () => {
    expect(parseLegacyPersisted(null)).toEqual(emptyDismissed());
    expect(parseLegacyPersisted('')).toEqual(emptyDismissed());
    expect(parseLegacyPersisted('{broken')).toEqual(emptyDismissed());
  });
});
