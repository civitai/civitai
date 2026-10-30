import { describe, expect, it } from 'vitest';
import { notificationImageIds } from '~/components/Notifications/notification-thumbnails';

describe('collecting the images a panel of notifications names', () => {
  it('asks for each image once, however many notifications name it', () => {
    const ids = notificationImageIds([
      { details: { imageId: 99 } },
      { details: { imageId: 99 } },
      { details: { imageId: 140197043 } },
    ]);

    // One entity per image is what keeps this a single batched query rather
    // than one per row in the panel.
    expect(ids).toEqual([99, 140197043]);
  });

  it('reads an id that came back from JSON as a string', () => {
    expect(notificationImageIds([{ details: { imageId: '99' } }])).toEqual([99]);
  });

  it.each([
    ['no details at all', undefined],
    ['details without an image', { placementId: 1 }],
    ['a null id', { imageId: null }],
    ['a non-numeric id', { imageId: 'unknown' }],
    ['a fractional id', { imageId: 1.5 }],
    ['a zero id', { imageId: 0 }],
    ['a negative id', { imageId: -1 }],
  ])('asks for nothing given %s', (_label, details) => {
    // Every one of these would otherwise reach the query as an entity, and an
    // entity list built from junk is a query that returns nothing slowly.
    expect(notificationImageIds([{ details: details ?? undefined }])).toEqual([]);
  });

  it('keeps the images it can read when a neighbouring row has none', () => {
    const ids = notificationImageIds([
      { details: { imageId: 'unknown' } },
      { details: { imageId: 7 } },
      {},
    ]);

    expect(ids).toEqual([7]);
  });
});
