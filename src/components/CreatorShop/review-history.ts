import type { CosmeticShopItemHistoryEntry } from '~/server/schema/cosmetic-shop.schema';
import { lastReviewIndex } from '~/server/services/creator-shop.data';

export const HISTORY_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  artwork: 'Artwork',
  offsets: 'Fit offsets',
  slug: 'Slug',
  uses: 'Uses per purchase',
  pricePerUse: 'Price per extra use',
  price: 'Price',
  quantity: 'Quantity',
};

const adverseActions = ['reject', 'request-changes', 'revert'] as const;
export type AdverseReviewAction = (typeof adverseActions)[number];

export const PRIOR_REVIEW_LABELS: Record<AdverseReviewAction, string> = {
  reject: 'Rejected',
  'request-changes': 'Changes requested',
  revert: 'Reverted to pending review',
};

const isAdverse = (action?: string): action is AdverseReviewAction =>
  adverseActions.includes(action as AdverseReviewAction);

export type PriorReview = {
  action: AdverseReviewAction;
  note?: string;
  at: string;
  reviewerId: number;
  /** Artwork replacements the creator made after that verdict. */
  artworkSwaps: number;
  /** Other fields they moved since, newest first, deduped. */
  editedFields: string[];
};

/**
 * The last verdict a moderator gave, if it was adverse and still unanswered by
 * an approval — plus what the creator changed since.
 *
 * A re-review needs this because the item itself no longer carries it: an edit
 * that puts the item back in the queue clears `rejectionReason`, so the next
 * reviewer sees a clean item and can approve what a colleague just turned down.
 * The artwork count matters most — a swap is how an unrelated piece reaches a
 * slot that was already paid for and already reviewed.
 *
 * Returns null once an approval follows the verdict (it was answered), and on
 * items whose history predates change tracking or whose verdict has aged out of
 * the capped log.
 */
export const priorReviewFromHistory = (
  history?: CosmeticShopItemHistoryEntry[]
): PriorReview | null => {
  const index = lastReviewIndex(history);
  if (index < 0 || !history) return null;

  const verdict = history[index];
  if (!isAdverse(verdict.action)) return null;

  let artworkSwaps = 0;
  const editedFields: string[] = [];
  for (let i = history.length - 1; i > index; i--) {
    for (const change of history[i].changes ?? []) {
      if (change.field === 'artwork') artworkSwaps++;
      else if (!editedFields.includes(change.field)) editedFields.push(change.field);
    }
  }

  return {
    action: verdict.action,
    note: verdict.note,
    at: verdict.at,
    reviewerId: verdict.userId,
    artworkSwaps,
    editedFields,
  };
};
