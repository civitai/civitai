/**
 * The viewer token the site signs for the app index's listings read model
 * (`apps/app-index-go/LISTINGS-READ-MODEL.md`, "Shadow diff"), against the literal vector its
 * verifier pins (`apps/app-index-go/internal/listingread/viewer_test.go`, computed with Python's
 * hmac, not with either signer), and the audience it is built from: the options object the database
 * read is given, read with the database read's own defaults.
 */
import { describe, expect, it } from 'vitest';
import {
  appIndexViewerFor,
  appIndexViewerKeyUsable,
  signAppIndexViewer,
} from '~/server/services/blocks/app-index-viewer-token';

// A test key, not a credential: the one viewer_test.go uses.
const TEST_KEY = '0123456789abcdef0123456789abcdef';
const VECTOR =
  'v1.eyJob3N0IjoicmVkIiwibGV2ZWwiOjE1LCJzY29wZSI6ImZ1bGwiLCJleHAiOjE3NjcyMjU2MDB9.FZ0CacyygXrG2YSxsuUyC9mbjHhsg5SCVWBUkPQNSds';

describe('signAppIndexViewer', () => {
  it("matches the read model's literal vector", () => {
    expect(
      signAppIndexViewer(TEST_KEY, { host: 'red', level: 15, scope: 'full' }, 1767225600)
    ).toBe(VECTOR);
  });

  it('signs with the key it is given (another key, another signature)', () => {
    const other = signAppIndexViewer(
      'fedcba9876543210fedcba9876543210',
      { host: 'red', level: 15, scope: 'full' },
      1767225600
    );
    expect(other.split('.').slice(0, 2)).toEqual(VECTOR.split('.').slice(0, 2));
    expect(other).not.toBe(VECTOR);
  });
});

describe('appIndexViewerFor', () => {
  it('carries the database read options with their defaults', () => {
    expect(appIndexViewerFor({ redCapable: true, viewerBrowsingLevel: 15, scope: 'full' })).toEqual(
      {
        host: 'red',
        level: 15,
        scope: 'full',
      }
    );
    expect(
      appIndexViewerFor({ redCapable: false, viewerBrowsingLevel: 31, scope: 'public-external' })
    ).toEqual({ host: 'main', level: 31, scope: 'public-external' });
    // Absent host, level and scope read as the database read reads them: not red-capable, the
    // public floor, and `none` (narrowStoreScope), never `full`.
    expect(appIndexViewerFor({})).toEqual({ host: 'main', level: 0, scope: 'none' });
    expect(appIndexViewerFor({ scope: 'everything' as never, viewerBrowsingLevel: null })).toEqual({
      host: 'main',
      level: 0,
      scope: 'none',
    });
  });

  it('has no token for a viewer the read model must not answer', () => {
    // A tester or moderator floor admits listings the read model does not hold.
    expect(appIndexViewerFor({ floor: 'testers', scope: 'full' })).toBeNull();
    expect(appIndexViewerFor({ floor: 'moderators', scope: 'full' })).toBeNull();
    // A level the token cannot carry exactly is answered from the database, never rounded.
    for (const viewerBrowsingLevel of [-1, 64, 1.5, Number.NaN]) {
      expect(appIndexViewerFor({ viewerBrowsingLevel, scope: 'full' })).toBeNull();
    }
    expect(appIndexViewerFor({ floor: 'public', viewerBrowsingLevel: 63, scope: 'full' })).toEqual({
      host: 'main',
      level: 63,
      scope: 'full',
    });
  });
});

describe('appIndexViewerKeyUsable', () => {
  it('needs at least 32 bytes, as the read model does', () => {
    expect(appIndexViewerKeyUsable(TEST_KEY)).toBe(true);
    expect(appIndexViewerKeyUsable(TEST_KEY.slice(0, 31))).toBe(false);
    expect(appIndexViewerKeyUsable(undefined)).toBe(false);
    expect(appIndexViewerKeyUsable('')).toBe(false);
  });
});
