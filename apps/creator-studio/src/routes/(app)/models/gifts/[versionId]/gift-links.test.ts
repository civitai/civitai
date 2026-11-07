import { describe, expect, it } from 'vitest';
import { groupGiftLinks, type GiftLinkRow } from './gift-links';

const row = (over: Partial<GiftLinkRow>): GiftLinkRow => ({
  id: 1,
  codeHint: 'ABCD',
  label: null,
  batchId: null,
  maxRedemptions: null,
  redemptionCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-11-07T00:00:00Z',
  ...over,
});

describe('groupGiftLinks', () => {
  it('keeps links as rows and folds a batch into one row with its own counts', () => {
    const groups = groupGiftLinks([
      row({ id: 1, redemptionCount: 4, maxRedemptions: 10 }),
      row({ id: 2, batchId: 'b', maxRedemptions: 1, redemptionCount: 1 }),
      row({ id: 3, batchId: 'b', maxRedemptions: 1, revokedAt: '2026-11-07T01:00:00Z' }),
      row({ id: 4, batchId: 'b', maxRedemptions: 1 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'link', link: { id: 1 } });
    expect(groups[1]).toMatchObject({ kind: 'batch', total: 3, redeemed: 1, revoked: 1 });
  });
});
