import { describe, expect, it } from 'vitest';
import {
  BULK_SAVE_MAX_IMAGES,
  bulkSaveCollectionItemsInput,
} from '~/server/schema/collection.schema';

// Each image in a bulk save is checked before it is added, so one request carries a bounded list.
describe('bulkSaveCollectionItemsInput image cap', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('accepts a full batch', () => {
    expect(
      bulkSaveCollectionItemsInput.safeParse({
        collectionId: 1,
        imageIds: ids(BULK_SAVE_MAX_IMAGES),
      }).success
    ).toBe(true);
  });

  it('refuses one image over, saying why', () => {
    const result = bulkSaveCollectionItemsInput.safeParse({
      collectionId: 1,
      imageIds: ids(BULK_SAVE_MAX_IMAGES + 1),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      `You can add up to ${BULK_SAVE_MAX_IMAGES} images at a time`
    );
  });
});
