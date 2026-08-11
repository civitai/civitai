import { CollectionInviteStatus } from '~/shared/utils/prisma/enums';

export const INVITE_EXPIRY_DAYS = 7;

export function inviteExpiryCutoff() {
  return new Date(Date.now() - INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

// The invites that represent a live or still-open seat. Shared by the caps, the roster and the
// contributor resync so the three can't disagree about who occupies one — re-inviting an accepted
// collaborator flips their invite back to Pending, and a check that only looked at Accepted would
// drop them for the 7-day window while the caps still charged for them.
//
// Lives in its own leaf module because `collection.service` needs it too, and
// `collection-collaborator.service` already imports `collection.service`.
export function liveInviteWhere(collectionId: number) {
  return {
    collectionId,
    OR: [
      { status: CollectionInviteStatus.Accepted },
      { status: CollectionInviteStatus.Pending, createdAt: { gte: inviteExpiryCutoff() } },
    ],
  };
}
