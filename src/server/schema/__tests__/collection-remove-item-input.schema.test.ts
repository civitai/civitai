import { describe, expect, it } from 'vitest';
import { removeCollectionItemInput } from '~/server/schema/collection.schema';

describe('removeCollectionItemInput', () => {
  it('takes one item or a list of items', () => {
    expect(removeCollectionItemInput.safeParse({ collectionId: 1, itemId: 2 }).success).toBe(true);
    expect(removeCollectionItemInput.safeParse({ collectionId: 1, itemIds: [2, 3] }).success).toBe(
      true
    );
  });

  it('refuses both, neither, an empty list, or more than 100 items', () => {
    const parse = (input: object) =>
      removeCollectionItemInput.safeParse({ collectionId: 1, ...input }).success;
    expect(parse({ itemId: 2, itemIds: [3] })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse({ itemIds: [] })).toBe(false);
    expect(parse({ itemIds: Array.from({ length: 101 }, (_, i) => i + 1) })).toBe(false);
  });
});
