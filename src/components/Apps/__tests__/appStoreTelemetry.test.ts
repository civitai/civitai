import { describe, expect, it, beforeEach } from 'vitest';

import {
  __appStoreImpressionTestHooks,
  appStoreActionDetails,
  claimImpression,
} from '~/components/Apps/appStoreTelemetry';
import { trackActionSchema } from '~/server/schema/track.schema';
import { APP_STORE_QUERY_MAX } from '~/shared/utils/app-store-telemetry';

/**
 * The browser half of `AppStore_Action`: the exact payload a card sends, and that the server
 * schema (`/api/track/batch`) accepts exactly that and refuses text where ids belong.
 *
 * 🔴 A rejected event is dropped with a 200 and takes its whole beacon batch with it, so the
 * client builder and the server schema must agree — asserted by feeding one into the other.
 */

const parse = (details: unknown) =>
  trackActionSchema.safeParse({ type: 'AppStore_Action', details });

describe('appStoreActionDetails', () => {
  it('builds the full store-grid payload, and the server schema accepts it', () => {
    const details = appStoreActionDetails('card_click', 'apl_01ABC', {
      surface: 'store_card',
      position: 4,
      sort: 'newest',
      category: 'games',
      query: '  pixel art  ',
    });
    expect(details).toEqual({
      action: 'card_click',
      listingId: 'apl_01ABC',
      surface: 'store_card',
      position: 4,
      sort: 'newest',
      category: 'games',
      query: 'pixel art',
    });
    expect(parse(details).success).toBe(true);
  });

  it('drops a value the schema would reject instead of losing the batch', () => {
    const details = appStoreActionDetails('impression', 'apl_01ABC', {
      surface: 'related',
      position: -1,
      category: 'hats',
      query: 'x'.repeat(APP_STORE_QUERY_MAX + 50),
    });
    expect(details).toEqual({
      action: 'impression',
      listingId: 'apl_01ABC',
      surface: 'related',
      query: 'x'.repeat(APP_STORE_QUERY_MAX),
    });
    expect(parse(details).success).toBe(true);
  });

  it('builds nothing for an id that is not a generated id', () => {
    expect(appStoreActionDetails('impression', 'Cool App', { surface: 'store_card' })).toBeNull();
  });
});

describe('AppStore_Action schema arm', () => {
  const OK = { action: 'detail_view', listingId: 'apl_01ABC', surface: 'detail' };

  it('accepts the minimal shape (positive control)', () => {
    expect(parse(OK).success).toBe(true);
  });

  it.each([
    ['an unknown action', { ...OK, action: 'purchase' }],
    ['an unknown surface', { ...OK, surface: 'banner' }],
    ['text as a listing id', { ...OK, listingId: 'My <b>App</b>' }],
    ['an over-long query', { ...OK, query: 'x'.repeat(APP_STORE_QUERY_MAX + 1) }],
    ['an empty query', { ...OK, query: '' }],
    ['an unknown sort', { ...OK, sort: 'random' }],
    ['an unknown category', { ...OK, category: 'hats' }],
    ['a fractional position', { ...OK, position: 1.5 }],
  ])('rejects %s', (_l, details) => {
    expect(parse(details).success).toBe(false);
  });
});

describe('claimImpression — once per listing per surface per page view', () => {
  beforeEach(() => __appStoreImpressionTestHooks.reset());

  it('claims once on a page', () => {
    expect(claimImpression('store_card', 'apl_1', '/apps/store')).toBe(true);
    expect(claimImpression('store_card', 'apl_1', '/apps/store')).toBe(false);
  });

  it('a different listing or surface is its own impression', () => {
    expect(claimImpression('store_card', 'apl_1', '/apps/store')).toBe(true);
    expect(claimImpression('store_card', 'apl_2', '/apps/store')).toBe(true);
    expect(claimImpression('sub_listing', 'apl_1', '/apps/store')).toBe(true);
  });

  it('a new page view (pathname) starts a fresh set', () => {
    expect(claimImpression('related', 'apl_1', '/apps/store-preview/a')).toBe(true);
    expect(claimImpression('related', 'apl_1', '/apps/store-preview/b')).toBe(true);
    expect(claimImpression('related', 'apl_1', '/apps/store-preview/b')).toBe(false);
  });
});
