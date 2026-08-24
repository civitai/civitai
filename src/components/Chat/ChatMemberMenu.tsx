import { Menu, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCrown, IconDotsVertical, IconUserX } from '@tabler/icons-react';
import produce from 'immer';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';
import type { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Admin-only actions on one other member of a group. Rendered beside the member
 * chip rather than on it, so the avatar keeps its profile link.
 */
export function ChatMemberMenu({
  chatObj,
  member,
}: {
  chatObj: ChatListMessage;
  member: ChatListMessage['chatMembers'][number];
}) {
  const queryUtils = trpc.useUtils();

  const { mutate, isPending } = trpc.chat.modifyUser.useMutation({
    onSuccess(data, req) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          const tChat = old?.find((c) => c.id === chatObj.id);
          if (!tChat) return old;

          if (req.isOwner) {
            for (const cm of tChat.chatMembers) cm.isOwner = cm.id === req.chatMemberId;
            tChat.ownerId = data.userId;
          } else {
            const tMember = tChat.chatMembers.find((cm) => cm.id === req.chatMemberId);
            if (tMember) tMember.status = data.status;
          }
        })
      );
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update member.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const promoteModal = () =>
    openConfirmModal({
      title: `Make ${member.user.username} the group admin?`,
      children: (
        <Text size="sm">
          They will be able to add and remove members. You will no longer be the admin.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Make admin', cancel: 'Cancel' },
      onConfirm: () => mutate({ chatMemberId: member.id, isOwner: true }),
    });

  const removeModal = () =>
    openConfirmModal({
      title: `Remove ${member.user.username} from this group?`,
      children: <Text size="sm">They will no longer be able to post in this conversation.</Text>,
      centered: true,
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => mutate({ chatMemberId: member.id, status: ChatMemberStatus.Kicked }),
    });

  return (
    <Menu withArrow position="bottom-end" withinPortal>
      <Menu.Target>
        <LegacyActionIcon
          size="sm"
          disabled={isPending}
          aria-label={`Member options for ${member.user.username}`}
        >
          <IconDotsVertical size={16} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {member.status === ChatMemberStatus.Joined && (
          <Menu.Item leftSection={<IconCrown size={18} />} onClick={promoteModal}>
            Make admin
          </Menu.Item>
        )}
        <Menu.Item leftSection={<IconUserX size={18} />} color="red" onClick={removeModal}>
          Remove from group
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
