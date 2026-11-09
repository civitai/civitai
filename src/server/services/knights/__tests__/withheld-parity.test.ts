import { describe, expect, it } from 'vitest';
import {
  isListingDisplayable as shopRule,
  withheldCosmeticIds,
} from '@civitai/shared/knights-shop';
import { isListingDisplayable as mainRule } from '~/server/services/creator-shop.data';
import { CosmeticFlag } from '~/shared/constants/cosmetic-flags.constants';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

// The Knights shop decides "can this cosmetic be worn yet" with a copy of the main app's rule, because the apps cannot
// import `src/`. These cases pin the copy to the original so the shop and `equipCosmetic` never disagree.
const approve = { kind: 'reviewed', action: 'approve', at: 't', userId: 1 };
const reject = { kind: 'reviewed', action: 'reject', at: 't', userId: 1 };
const edit = (field: string) => ({
  kind: 'edited',
  at: 't',
  userId: 2,
  changes: [{ field, from: 'a', to: 'b' }],
});

const CASES = [
  ['published', CosmeticShopItemStatus.Published, {}, null],
  ['pending, no verdict', CosmeticShopItemStatus.PendingReview, {}, null],
  [
    'pending, legacy approved amount',
    CosmeticShopItemStatus.PendingReview,
    { lastApprovedAmount: 5 },
    null,
  ],
  [
    'pending, legacy approved amount with a reason',
    CosmeticShopItemStatus.PendingReview,
    { lastApprovedAmount: 5 },
    'no',
  ],
  ['approved then archived', CosmeticShopItemStatus.Archived, { history: [approve] }, null],
  ['rejected', CosmeticShopItemStatus.Rejected, { history: [reject] }, 'no'],
  ['approved then rejected', CosmeticShopItemStatus.Rejected, { history: [approve, reject] }, 'no'],
  [
    'approved then artwork edit',
    CosmeticShopItemStatus.PendingReview,
    { history: [approve, edit('artwork')] },
    null,
  ],
  [
    'approved then price edit',
    CosmeticShopItemStatus.PendingReview,
    { history: [approve, edit('price')] },
    null,
  ],
  ['stored verdict true', CosmeticShopItemStatus.PendingReview, { displayApproved: true }, null],
  ['stored verdict false', CosmeticShopItemStatus.Published, { displayApproved: false }, null],
  [
    'taken down',
    CosmeticShopItemStatus.Archived,
    { takedown: { at: 't' }, displayApproved: true },
    null,
  ],
] as const;

describe('the shop copy of the creator-shop display rule', () => {
  it.each(CASES)('agrees with the main app: %s', (_label, status, meta, rejectionReason) => {
    const listing = { status, meta, rejectionReason };
    expect(shopRule(listing)).toBe(mainRule(listing as Parameters<typeof mainRule>[0]));
  });

  it('keeps a deleted pending listing withheld by the same flag', () => {
    const flags = CosmeticFlag.Withheld;
    expect([...withheldCosmeticIds([{ id: 1, createdById: 9, flags }], [])]).toEqual([1]);
  });
});
