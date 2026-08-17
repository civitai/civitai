import { describe, expect, it } from 'vitest';
import { updateCollectionItemsStatusInput } from '~/server/schema/collection.schema';
import { CollectionItemRejectionReason, CollectionItemStatus } from '~/shared/utils/prisma/enums';

const base = {
  collectionId: 1,
  collectionItemIds: [10],
  status: CollectionItemStatus.REJECTED,
};

describe('updateCollectionItemsStatusInput', () => {
  it('accepts a rejection with no reason at all', () => {
    expect(updateCollectionItemsStatusInput.safeParse(base).success).toBe(true);
  });

  it('accepts a canned reason', () => {
    const result = updateCollectionItemsStatusInput.safeParse({
      ...base,
      rejectionReason: CollectionItemRejectionReason.Duplicate,
    });
    expect(result.success).toBe(true);
  });

  it('trims the free text', () => {
    const result = updateCollectionItemsStatusInput.safeParse({
      ...base,
      rejectionReason: CollectionItemRejectionReason.Other,
      rejectionDetail: '  crop the watermark  ',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rejectionDetail).toBe('crop the watermark');
  });

  it('refuses Other with no free text', () => {
    const result = updateCollectionItemsStatusInput.safeParse({
      ...base,
      rejectionReason: CollectionItemRejectionReason.Other,
    });
    expect(result.success).toBe(false);
  });

  it('refuses Other with only whitespace', () => {
    const result = updateCollectionItemsStatusInput.safeParse({
      ...base,
      rejectionReason: CollectionItemRejectionReason.Other,
      rejectionDetail: '     ',
    });
    expect(result.success).toBe(false);
  });

  // Automated is the AI reviewer's value. A client must never be able to make a
  // human rejection look like the bot's.
  it('refuses Automated from a client', () => {
    const result = updateCollectionItemsStatusInput.safeParse({
      ...base,
      rejectionReason: CollectionItemRejectionReason.Automated,
      rejectionDetail: 'pretending to be the bot',
    });
    expect(result.success).toBe(false);
  });

  it('refuses free text longer than 200 characters', () => {
    const result = updateCollectionItemsStatusInput.safeParse({
      ...base,
      rejectionReason: CollectionItemRejectionReason.Other,
      rejectionDetail: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});
