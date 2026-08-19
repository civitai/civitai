import { describe, expect, it } from 'vitest';
import type { CosmeticShopItemHistoryEntry } from '~/server/schema/cosmetic-shop.schema';
import { priorReviewFromHistory } from '~/components/CreatorShop/review-history';

const submitted: CosmeticShopItemHistoryEntry = {
  at: '2026-08-01T00:00:00.000Z',
  userId: 11,
  kind: 'submitted',
  status: 'PendingReview',
};

const requestedChanges: CosmeticShopItemHistoryEntry = {
  at: '2026-08-02T00:00:00.000Z',
  userId: 99,
  kind: 'reviewed',
  status: 'RequestedChanges',
  action: 'request-changes',
  note: 'Visual quality - your badge is very very tiny',
};

const artworkSwap = (at: string): CosmeticShopItemHistoryEntry => ({
  at,
  userId: 11,
  kind: 'edited',
  status: 'PendingReview',
  changes: [{ field: 'artwork', from: 'old.png', to: 'new.png' }],
});

describe('priorReviewFromHistory', () => {
  it('returns null for items with no recorded history', () => {
    expect(priorReviewFromHistory(undefined)).toBeNull();
    expect(priorReviewFromHistory([])).toBeNull();
  });

  it('surfaces the note of an unanswered request-changes verdict', () => {
    const prior = priorReviewFromHistory([submitted, requestedChanges]);
    expect(prior).toMatchObject({
      action: 'request-changes',
      note: requestedChanges.note,
      reviewerId: 99,
      at: requestedChanges.at,
      artworkSwaps: 0,
      editedFields: [],
    });
  });

  it('counts every artwork swap made since that verdict', () => {
    const prior = priorReviewFromHistory([
      submitted,
      requestedChanges,
      artworkSwap('2026-08-03T00:00:00.000Z'),
      artworkSwap('2026-08-04T00:00:00.000Z'),
    ]);
    expect(prior?.artworkSwaps).toBe(2);
  });

  it('does not count swaps made before the verdict', () => {
    const prior = priorReviewFromHistory([
      submitted,
      artworkSwap('2026-08-01T12:00:00.000Z'),
      requestedChanges,
    ]);
    expect(prior?.artworkSwaps).toBe(0);
  });

  it('lists the other fields moved since, deduped and newest first', () => {
    const edit = (at: string, field: string): CosmeticShopItemHistoryEntry => ({
      at,
      userId: 11,
      kind: 'edited',
      status: 'PendingReview',
      changes: [{ field, from: 1, to: 2 }],
    });
    const prior = priorReviewFromHistory([
      submitted,
      requestedChanges,
      edit('2026-08-03T00:00:00.000Z', 'price'),
      edit('2026-08-04T00:00:00.000Z', 'quantity'),
      edit('2026-08-05T00:00:00.000Z', 'price'),
    ]);
    expect(prior?.editedFields).toEqual(['price', 'quantity']);
  });

  it('goes quiet once an approval answers the verdict', () => {
    const prior = priorReviewFromHistory([
      submitted,
      requestedChanges,
      artworkSwap('2026-08-03T00:00:00.000Z'),
      {
        at: '2026-08-04T00:00:00.000Z',
        userId: 99,
        kind: 'reviewed',
        status: 'Published',
        action: 'approve',
      },
    ]);
    expect(prior).toBeNull();
  });

  it('reports only the most recent verdict when there were several', () => {
    const prior = priorReviewFromHistory([
      submitted,
      requestedChanges,
      artworkSwap('2026-08-03T00:00:00.000Z'),
      {
        at: '2026-08-04T00:00:00.000Z',
        userId: 77,
        kind: 'reviewed',
        status: 'RequestedChanges',
        action: 'request-changes',
        note: 'the sides are stretched too much',
      },
      artworkSwap('2026-08-05T00:00:00.000Z'),
    ]);
    expect(prior).toMatchObject({
      note: 'the sides are stretched too much',
      reviewerId: 77,
      artworkSwaps: 1,
    });
  });

  it.each(['reject', 'revert'] as const)('treats a %s verdict as unanswered too', (action) => {
    const prior = priorReviewFromHistory([
      submitted,
      {
        at: '2026-08-02T00:00:00.000Z',
        userId: 99,
        kind: 'reviewed',
        status: 'x',
        action,
        note: 'no',
      },
    ]);
    expect(prior?.action).toBe(action);
  });
});
