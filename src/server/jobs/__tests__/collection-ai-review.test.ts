import { describe, expect, it } from 'vitest';
import { CollectionItemRejectionReason, CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { resolveAutomatedRejectionReason } from '~/server/jobs/collection-ai-review';

describe('resolveAutomatedRejectionReason', () => {
  it('files an AI rejection under Automated', () => {
    expect(resolveAutomatedRejectionReason({ status: CollectionItemStatus.REJECTED })).toBe(
      CollectionItemRejectionReason.Automated
    );
  });

  it('leaves an acceptance with no reason', () => {
    expect(
      resolveAutomatedRejectionReason({ status: CollectionItemStatus.ACCEPTED })
    ).toBeUndefined();
  });
});
