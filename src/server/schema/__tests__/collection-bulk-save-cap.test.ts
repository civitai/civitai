import { describe, expect, it } from 'vitest';
import {
  addSimpleImagePostInput,
  BULK_SAVE_MAX_ITEMS,
  bulkSaveCollectionItemsInput,
} from '~/server/schema/collection.schema';

// Each item in a bulk save is checked before it is added, so one request carries a bounded list.
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe.each([
  ['imageIds', 'images'],
  ['postIds', 'posts'],
  ['articleIds', 'articles'],
  ['modelIds', 'models'],
])('bulkSaveCollectionItemsInput %s cap', (key, noun) => {
  it('accepts a full batch', () => {
    expect(
      bulkSaveCollectionItemsInput.safeParse({ collectionId: 1, [key]: ids(BULK_SAVE_MAX_ITEMS) })
        .success
    ).toBe(true);
  });

  it('refuses one over, saying why', () => {
    const result = bulkSaveCollectionItemsInput.safeParse({
      collectionId: 1,
      [key]: ids(BULK_SAVE_MAX_ITEMS + 1),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      `You can add up to ${BULK_SAVE_MAX_ITEMS} ${noun} at a time`
    );
  });
});

describe('addSimpleImagePostInput upload cap', () => {
  const capMessage = `You can upload up to ${BULK_SAVE_MAX_ITEMS} images at a time`;
  const messages = (n: number) =>
    (
      addSimpleImagePostInput.safeParse({
        collectionId: 1,
        images: Array.from({ length: n }, () => ({})),
      }).error?.issues ?? []
    )
      .filter((issue) => issue.path.length === 1 && issue.path[0] === 'images')
      .map((issue) => issue.message);

  it('does not refuse a full batch for its size', () => {
    expect(messages(BULK_SAVE_MAX_ITEMS)).not.toContain(capMessage);
  });

  it('refuses one over, saying why', () => {
    expect(messages(BULK_SAVE_MAX_ITEMS + 1)).toContain(capMessage);
  });
});
