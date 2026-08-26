import { Group, Menu, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { ChatMemberStatus, ChatNotifyLevel } from '~/shared/utils/prisma/enums';
import {
  IconArchive,
  IconArrowsJoin2,
  IconBell,
  IconBellOff,
  IconDoorExit,
  IconDots,
  IconFlag,
  IconPin,
  IconPinnedOff,
  IconSettings,
  IconTrash,
  IconPencil,
  IconUserPlus,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import React, { useState } from 'react';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { ChatAddMembersModal } from '~/components/Chat/ChatAddMembersModal';
import { ChatRenameModal } from '~/components/Chat/ChatRenameModal';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';
import type { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const ChatActions = ({ chatObj }: { chatObj?: ChatListMessage }) => {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [addingMembers, setAddingMembers] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const myMember = chatObj?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const modSender = chatObj?.chatMembers.find(
    (cm) => cm.userId !== currentUser?.id && cm.isOwner === true && cm.user.isModerator === true
  );
  const cantLeave = modSender?.status === ChatMemberStatus.Joined && !myMember?.user.isModerator;
  // `chatMembers.length` is the fallback for threads that predate `Chat.isGroup`
  // and have not been backfilled.
  const isGroup = !!chatObj?.isGroup || (chatObj?.chatMembers.length ?? 0) > 2;
  const isAdmin = isGroup && !!currentUser && chatObj?.ownerId === currentUser.id;
  // Moderators are left out: blocking one severs the conversation the
  // `cantLeave` guard exists to hold open.
  const blockable =
    chatObj?.chatMembers.filter((cm) => cm.userId !== currentUser?.id && !cm.user.isModerator) ??
    [];
  const isMuted = myMember?.notifyLevel === ChatNotifyLevel.None;
  const isPinned = !!myMember?.pinnedAt;

  const { mutate: modifyMembership } = trpc.chat.modifyUser.useMutation({
    onSuccess(data, req) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const tChat = old.find((c) => c.id === chatObj?.id);
          const tMember = tChat?.chatMembers?.find((cm) => cm.userId === data.userId);
          if (!tMember) return old;

          if (isDefined(req.status)) {
            tMember.status = data.status;
            // Accepting clears the request mark server-side; dropping it here left
            // the conversation stuck in the Requests tab.
            tMember.filteredAt = data.filteredAt;
          }
          if (isDefined(req.isMuted)) {
            tMember.isMuted = data.isMuted;
          }
          if (isDefined(req.notifyLevel)) {
            tMember.notifyLevel = data.notifyLevel;
          }
          if (isDefined(req.isPinned)) {
            tMember.pinnedAt = data.pinnedAt;
          }
        })
      );
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update chat membership.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const { mutate: clearChat } = trpc.chat.clearChat.useMutation({
    onSuccess() {
      useChatStore.setState({ existingChatId: undefined });
      queryUtils.chat.getAllByUser.invalidate();
      queryUtils.chat.getUnreadCount.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to delete conversation.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const withMember = (update: (chatMemberId: number) => void) => {
    if (!myMember || !currentUser) {
      showErrorNotification({
        title: 'Failed to update chat membership.',
        error: new Error('Could not find membership or user'),
        autoClose: false,
      });
      return;
    }
    update(myMember.id);
  };

  const toggleNotifications = () =>
    withMember((chatMemberId) =>
      modifyMembership({
        chatMemberId,
        notifyLevel: isMuted ? ChatNotifyLevel.All : ChatNotifyLevel.None,
      })
    );

  const togglePin = () =>
    withMember((chatMemberId) => modifyMembership({ chatMemberId, isPinned: !isPinned }));

  const adjustChat = (status: ChatMemberStatus) =>
    withMember((chatMemberId) => modifyMembership({ chatMemberId, status }));

  // TODO probably don't close modal until left
  const leaveModal = () =>
    openConfirmModal({
      title: 'Really leave this chat?',
      children: <Text size="sm">You can rejoin at any time from the Archived tab.</Text>,
      centered: true,
      labels: { confirm: 'Confirm', cancel: 'Cancel' },
      onConfirm: () => adjustChat(ChatMemberStatus.Left),
    });

  const deleteModal = () => {
    if (!chatObj) return;
    openConfirmModal({
      title: 'Delete this conversation?',
      children: (
        <Text size="sm">
          It disappears from your messages and a new conversation with this person starts empty.
          Only your side is cleared — they keep their copy.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => clearChat({ chatId: chatObj.id }),
    });
  };

  const reportModal = () => {
    if (!chatObj) return;
    openReportModal({
      entityType: ReportEntity.Chat,
      entityId: chatObj.id,
    });
  };

  const isJoined = myMember?.status === ChatMemberStatus.Joined;

  return (
    <Group wrap="nowrap" gap={6}>
      {!!chatObj && (
        <Menu withArrow position="bottom-end">
          <Menu.Target>
            <LegacyActionIcon aria-label="Conversation options">
              <IconDots />
            </LegacyActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {isJoined && isAdmin && (
              <>
                <Menu.Label>Admin actions</Menu.Label>
                <Menu.Item
                  leftSection={<IconUserPlus size={18} />}
                  onClick={() => setAddingMembers(true)}
                >
                  Add members
                </Menu.Item>
                <Menu.Item leftSection={<IconPencil size={18} />} onClick={() => setRenaming(true)}>
                  Rename group
                </Menu.Item>
                <Menu.Divider />
              </>
            )}
            {isJoined && (
              <>
                <Menu.Item
                  leftSection={isMuted ? <IconBell size={18} /> : <IconBellOff size={18} />}
                  onClick={toggleNotifications}
                >
                  {`${isMuted ? 'Enable' : 'Disable'} notifications`}
                </Menu.Item>
                <Menu.Item
                  leftSection={isPinned ? <IconPinnedOff size={18} /> : <IconPin size={18} />}
                  onClick={togglePin}
                >
                  {`${isPinned ? 'Unpin' : 'Pin'} conversation`}
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconSettings size={18} />}
                  onClick={() =>
                    useChatStore.setState({
                      isSettingsOpen: true,
                      settingsScope: 'conversation',
                    })
                  }
                >
                  Conversation settings
                </Menu.Item>
                <Menu.Divider />
              </>
            )}
            <Menu.Item leftSection={<IconFlag size={18} />} color="orange" onClick={reportModal}>
              Report
            </Menu.Item>
            {blockable.length === 1 ? (
              <BlockUserButton as="menu-item" userId={blockable[0].userId} />
            ) : blockable.length > 1 ? (
              <>
                <Menu.Label>Block a member</Menu.Label>
                {blockable.map((cm) => (
                  <BlockUserButton
                    key={cm.userId}
                    as="menu-item"
                    userId={cm.userId}
                    label={`Block ${cm.user.username ?? `user ${cm.userId}`}`}
                    unblockLabel={`Unblock ${cm.user.username ?? `user ${cm.userId}`}`}
                  />
                ))}
              </>
            ) : null}
            {isJoined && !isGroup && (
              <Menu.Item
                leftSection={<IconArchive size={18} />}
                onClick={() => adjustChat(ChatMemberStatus.Ignored)}
              >
                Archive conversation
              </Menu.Item>
            )}
            {isJoined ? (
              isGroup ? (
                <Tooltip
                  label={
                    cantLeave
                      ? 'Cannot leave a moderator chat while they are still present'
                      : undefined
                  }
                  disabled={!cantLeave}
                >
                  <Menu.Item
                    leftSection={<IconDoorExit size={18} />}
                    color="red"
                    onClick={leaveModal}
                    disabled={cantLeave}
                    style={cantLeave ? { pointerEvents: 'all', cursor: 'default' } : undefined}
                  >
                    Leave group
                  </Menu.Item>
                </Tooltip>
              ) : (
                <Menu.Item leftSection={<IconTrash size={18} />} color="red" onClick={deleteModal}>
                  Delete conversation
                </Menu.Item>
              )
            ) : myMember?.status === ChatMemberStatus.Left ||
              myMember?.status === ChatMemberStatus.Ignored ? (
              <Menu.Item
                leftSection={<IconArrowsJoin2 size={18} />}
                color="green"
                onClick={() => adjustChat(ChatMemberStatus.Joined)}
              >
                {myMember.status === ChatMemberStatus.Ignored ? 'Unarchive' : 'Rejoin'}
              </Menu.Item>
            ) : undefined}
          </Menu.Dropdown>
        </Menu>
      )}
      <LegacyActionIcon onClick={() => useChatStore.setState({ open: false })}>
        <IconX />
      </LegacyActionIcon>
      {!!chatObj && (
        <>
          <ChatAddMembersModal
            chatObj={chatObj}
            opened={addingMembers}
            onClose={() => setAddingMembers(false)}
          />
          <ChatRenameModal chatObj={chatObj} opened={renaming} onClose={() => setRenaming(false)} />
        </>
      )}
    </Group>
  );
};
