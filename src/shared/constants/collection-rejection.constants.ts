import { CollectionItemRejectionReason } from '~/shared/utils/prisma/enums';

export const COLLECTION_REJECTION_REASON_COPY: Record<CollectionItemRejectionReason, string> = {
  [CollectionItemRejectionReason.OffTopic]: "It doesn't fit this collection's theme.",
  [CollectionItemRejectionReason.WrongFormat]: "It isn't in the format this collection accepts.",
  [CollectionItemRejectionReason.Duplicate]: 'It duplicates another entry.',
  [CollectionItemRejectionReason.Quality]: "It doesn't meet this collection's quality bar.",
  [CollectionItemRejectionReason.RulesViolation]: "It violates this collection's rules.",
  [CollectionItemRejectionReason.Other]: '',
  [CollectionItemRejectionReason.Automated]: '',
};

// These two carry no fixed copy: what the submitter reads is whatever the reviewer
// (or the AI reviewer) wrote in `rejectionDetail`.
export const DETAIL_BACKED_REASONS = new Set<CollectionItemRejectionReason>([
  CollectionItemRejectionReason.Other,
  CollectionItemRejectionReason.Automated,
]);

export const SELECTABLE_REJECTION_REASONS = (
  Object.keys(COLLECTION_REJECTION_REASON_COPY) as CollectionItemRejectionReason[]
).filter((reason) => reason !== CollectionItemRejectionReason.Automated);

export function resolveRejectionCopy({
  reason,
  detail,
}: {
  reason?: CollectionItemRejectionReason | null;
  detail?: string | null;
}): string | undefined {
  if (!reason) return undefined;
  if (DETAIL_BACKED_REASONS.has(reason)) return detail?.trim() || undefined;
  return COLLECTION_REJECTION_REASON_COPY[reason] || undefined;
}
