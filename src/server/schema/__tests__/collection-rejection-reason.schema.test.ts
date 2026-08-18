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

  // A reviewer writes about someone else's entry, so free text is not reachable over the wire at
  // all — not merely absent from the modal. A client that sends it has it dropped.
  it('does not carry free text even when a client sends some', () => {
    const result = updateCollectionItemsStatusInput.safeParse({
      ...base,
      rejectionReason: CollectionItemRejectionReason.Duplicate,
      rejectionDetail: 'something a reviewer typed about another member',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty('rejectionDetail');
  });

  // Both detail-backed reasons render whatever sits in `rejectionDetail`. A client cannot supply
  // that, so letting one through would persist a reason that displays nothing to the submitter.
  it.each([CollectionItemRejectionReason.Other, CollectionItemRejectionReason.Automated])(
    'refuses %s from a client',
    (rejectionReason) => {
      const result = updateCollectionItemsStatusInput.safeParse({ ...base, rejectionReason });
      expect(result.success).toBe(false);
    }
  );
});
