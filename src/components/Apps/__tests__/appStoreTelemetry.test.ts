import { describe, expect, it, beforeEach } from 'vitest';

import {
  __appStoreImpressionTestHooks,
  appStoreActionDetails,
  claimImpression,
} from '~/components/Apps/appStoreTelemetry';
import { trackActionSchema } from '~/server/schema/track.schema';

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
      hasQuery: true,
      queryLength: '4-10',
    });
    expect(parse(details).success).toBe(true);
  });

  it('🔴 never carries the search TEXT — not as a field, not inside any value', () => {
    const secret = 'jane.doe private handle';
    const details = appStoreActionDetails('impression', 'apl_01ABC', {
      surface: 'store_card',
      query: secret,
    });
    expect(details).not.toHaveProperty('query');
    expect(JSON.stringify(details)).not.toContain('jane');
    expect(details).toMatchObject({ hasQuery: true, queryLength: '11-30' });
  });

  it('an empty search box is hasQuery false / bucket 0; a surface without one sends neither', () => {
    expect(
      appStoreActionDetails('impression', 'apl_01ABC', { surface: 'store_card', query: '   ' })
    ).toMatchObject({ hasQuery: false, queryLength: '0' });
    const related = appStoreActionDetails('impression', 'apl_01ABC', { surface: 'related' });
    expect(related).not.toHaveProperty('hasQuery');
    expect(related).not.toHaveProperty('queryLength');
  });

  it('drops a value the schema would reject instead of losing the batch', () => {
    const details = appStoreActionDetails('impression', 'apl_01ABC', {
      surface: 'related',
      position: -1,
      category: 'hats',
    });
    expect(details).toEqual({ action: 'impression', listingId: 'apl_01ABC', surface: 'related' });
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
    ['an unknown query-length bucket', { ...OK, queryLength: '12' }],
    ['a non-boolean hasQuery', { ...OK, hasQuery: 'yes' }],
    ['an unknown sort', { ...OK, sort: 'random' }],
    ['an unknown category', { ...OK, category: 'hats' }],
    ['a fractional position', { ...OK, position: 1.5 }],
  ])('rejects %s', (_l, details) => {
    expect(parse(details).success).toBe(false);
  });
});

describe('AppStore_Action schema never stores search text', () => {
  it('STRIPS a `query` key a stale or tampered client sends — the parsed event has no text', () => {
    const result = trackActionSchema.safeParse({
      type: 'AppStore_Action',
      details: {
        action: 'card_click',
        listingId: 'apl_01ABC',
        surface: 'store_card',
        query: 'jane.doe private handle',
        hasQuery: true,
        queryLength: '11-30',
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Positive control: the known fields survived, so the absence below is about `query`.
    const details = (result.data as { details?: unknown }).details;
    expect(details).toMatchObject({ hasQuery: true, queryLength: '11-30' });
    expect(details).not.toHaveProperty('query');
    expect(JSON.stringify(result.data)).not.toContain('jane');
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
