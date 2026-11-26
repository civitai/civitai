import { describe, expect, it } from 'vitest';
import { collectionItemExtraFields } from '~/server/services/blocks/block-collection-item-fields';

/**
 * The `addedAt` / `duration` fields each media item carries on
 * GET /api/v1/blocks/collections/[id]. An app reads `addedAt` to show when an item
 * joined the collection, and `'duration' in item` as "this video has a known length".
 */

describe('collectionItemExtraFields: addedAt', () => {
  it('is the collection item createdAt as ISO 8601', () => {
    expect(
      collectionItemExtraFields({
        mediaType: 'image',
        metadata: null,
        addedAt: new Date('2026-05-06T07:08:09.123Z'),
      }).addedAt
    ).toBe('2026-05-06T07:08:09.123Z');
    expect(
      collectionItemExtraFields({
        mediaType: 'video',
        metadata: null,
        addedAt: new Date('2025-12-31T23:59:59.000Z'),
      }).addedAt
    ).toBe('2025-12-31T23:59:59.000Z');
  });

  it('accepts an ISO string (a serialised date) and normalises it', () => {
    expect(
      collectionItemExtraFields({
        mediaType: 'image',
        metadata: null,
        addedAt: '2024-02-03T04:05:06Z',
      }).addedAt
    ).toBe('2024-02-03T04:05:06.000Z');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an unparseable string', 'not a date'],
    ['an invalid Date', new Date('nope')],
  ])('is null, and the key still present, when createdAt is %s', (_label, addedAt) => {
    const fields = collectionItemExtraFields({ mediaType: 'image', metadata: null, addedAt });
    expect(fields).toHaveProperty('addedAt', null);
  });
});

describe('collectionItemExtraFields: duration', () => {
  it.each([
    [12.5, 12.5],
    [3, 3],
  ])('is %s seconds on a video whose stored duration is %s', (stored, expected) => {
    expect(
      collectionItemExtraFields({
        mediaType: 'video',
        metadata: { duration: stored },
        addedAt: null,
      })
    ).toEqual({ addedAt: null, duration: expected });
  });

  it('is omitted on an image item, even when its metadata carries a duration', () => {
    const fields = collectionItemExtraFields({
      mediaType: 'image',
      metadata: { duration: 9 },
      addedAt: null,
    });
    expect(fields).not.toHaveProperty('duration');
  });

  it.each([
    ['metadata missing', undefined],
    ['metadata null', null],
    ['duration missing', { width: 1 }],
    ['duration null', { duration: null }],
    ['zero', { duration: 0 }],
    ['negative', { duration: -4 }],
    ['NaN', { duration: Number.NaN }],
    ['Infinity', { duration: Number.POSITIVE_INFINITY }],
    ['a numeric string', { duration: '12' }],
  ])('is omitted on a video when %s', (_label, metadata) => {
    const fields = collectionItemExtraFields({ mediaType: 'video', metadata, addedAt: null });
    expect(fields).not.toHaveProperty('duration');
  });
});
