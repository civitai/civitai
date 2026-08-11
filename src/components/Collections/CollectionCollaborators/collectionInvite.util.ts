import { INVITE_EXPIRY_DAYS } from '~/server/services/collection-invite.utils';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';
import type { CollectionMyInvite } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const DAY_MS = 24 * 60 * 60 * 1000;

export const roleLabels: Record<CollectionCollaboratorRole, string> = {
  [CollectionCollaboratorRole.Contributor]: 'Contributor',
  [CollectionCollaboratorRole.Manager]: 'Manager',
};

export function inviterLabel(invitedBy: CollectionMyInvite['invitedBy']) {
  if (!invitedBy.username || invitedBy.deletedAt) return 'Someone';
  return `@${invitedBy.username}`;
}

export function inviteExpiry(createdAt: Date | string) {
  const expiresAt = new Date(new Date(createdAt).getTime() + INVITE_EXPIRY_DAYS * DAY_MS);
  return { expiresAt, expiringSoon: expiresAt.getTime() - Date.now() < DAY_MS };
}

export function useRespondToInvite() {
  const utils = trpc.useUtils();

  return trpc.collection.respondToInvite.useMutation({
    onSuccess: async (_, { accept }) => {
      showSuccessNotification({ message: accept ? 'Invite accepted' : 'Invite declined' });
      await Promise.all([
        utils.collection.getMyInvites.invalidate(),
        utils.collection.getAllUser.invalidate(),
      ]);
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not respond to invite',
        error: new Error(error.message),
      }),
  });
}
