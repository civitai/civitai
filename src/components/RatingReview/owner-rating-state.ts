type ReviewLike = {
  status: string;
  createdAt: Date | string;
  resolvedAt: Date | string | null;
  modComment: string | null;
};

export type OwnerRatingButtonState =
  | { kind: 'open' }
  | { kind: 'pending'; createdAt: Date | string }
  | {
      kind: 'resolved';
      label: string;
      resolvedAt: Date | string | null;
      modComment: string | null;
    };

export function ownerRatingButtonState(
  review: ReviewLike | null | undefined,
  canResubmit: boolean
): OwnerRatingButtonState {
  if (!review) return { kind: 'open' };
  if (review.status === 'Pending') return { kind: 'pending', createdAt: review.createdAt };
  if (canResubmit) return { kind: 'open' };
  const label =
    review.status === 'Actioned'
      ? 'approved'
      : review.status === 'Unactioned'
      ? 'declined'
      : review.status.toLowerCase();
  return { kind: 'resolved', label, resolvedAt: review.resolvedAt, modComment: review.modComment };
}
