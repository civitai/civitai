import { ActionIcon, Group, Menu, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { ChatMemberStatus } from '~/shared/utils/prisma/enums';
import {
  IconArrowsJoin2,
  IconBell,
  IconBellOff,
  IconDoorExit,
  IconFlag,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import React from 'react';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import type { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const ChatActions = ({ chatObj }: { chatObj?: ChatListMessage }) => {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  // const isOwner = myMember?.isOwner === true;
  const myMember = chatObj?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const modSender = chatObj?.chatMembers.find(
    (cm) => cm.userId !== currentUser?.id && cm.isOwner === true && cm.user.isModerator === true
  );
  const cantLeave = modSender?.status === ChatMemberStatus.Joined && !myMember?.user.isModerator;

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
          }
          if (isDefined(req.isMuted)) {
            tMember.isMuted = data.isMuted;
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

  const toggleNotifications = () => {
    if (!myMember || !currentUser) {
      showErrorNotification({
        title: 'Failed to update chat membership.',
        error: new Error('Could not find membership or user'),
        autoClose: false,
      });
      return;
    }

    modifyMembership({
      chatMemberId: myMember.id,
      isMuted: !myMember.isMuted,
    });
  };

  const adjustChat = (status: ChatMemberStatus) => {
    if (!myMember || !currentUser) {
      showErrorNotification({
        title: 'Failed to update chat membership.',
        error: new Error('Could not find membership or user'),
        autoClose: false,
      });
      return;
    }

    modifyMembership({
      chatMemberId: myMember.id,
      status: status,
    });
  };

  // TODO probably don't close modal until left
  const leaveModal = () =>
    openConfirmModal({
      title: 'Really leave this chat?',
      children: <Text size="sm">You can rejoin at any time from the Archived tab.</Text>,
      centered: true,
      labels: { confirm: 'Confirm', cancel: 'Cancel' },
      onConfirm: () => adjustChat(ChatMemberStatus.Left),
    });

  const reportModal = () => {
    if (!chatObj) return;
    openReportModal({
      entityType: ReportEntity.Chat,
      entityId: chatObj.id,
    });
  };

  return (
    <Group wrap="nowrap" gap={6}>
      {!!chatObj && (
        <Menu withArrow position="bottom-end">
          <Menu.Target>
            <LegacyActionIcon>
              <IconSettings />
            </LegacyActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <>
              {/*<Menu.Label>Owner Actions</Menu.Label>*/}
              {/*TODO enable these*/}
              {/*{isOwner && <Menu.Item leftSection={<IconUserPlus size={18} />}>Add users</Menu.Item>}*/}
              {/*{isOwner && <Menu.Item leftSection={<IconUserX size={18} />}>Ban users</Menu.Item>}*/}
              {/*<Menu.Label>Chat Actions</Menu.Label>*/}
              {myMember?.status === ChatMemberStatus.Joined && (
                <Menu.Item
                  leftSection={
                    myMember?.isMuted ? <IconBell size={18} /> : <IconBellOff size={18} />
                  }
                  onClick={toggleNotifications}
                >{`${myMember?.isMuted ? 'Enable' : 'Disable'} notifications`}</Menu.Item>
              )}
              <Menu.Item leftSection={<IconFlag size={18} />} color="orange" onClick={reportModal}>
                Report
              </Menu.Item>
              {myMember?.status === ChatMemberStatus.Joined ? (
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
                    Leave
                  </Menu.Item>
                </Tooltip>
              ) : myMember?.status === ChatMemberStatus.Left ? (
                <Menu.Item
                  leftSection={<IconArrowsJoin2 size={18} />}
                  color="green"
                  onClick={() => adjustChat(ChatMemberStatus.Joined)}
                >
                  Rejoin
                </Menu.Item>
              ) : undefined}
            </>

            {/* TODO blocklist here? */}
            {/*<Menu.Item>Manage blocklist</Menu.Item>*/}
          </Menu.Dropdown>
        </Menu>
      )}
      <LegacyActionIcon onClick={() => useChatStore.setState({ open: false })}>
        <IconX />
      </LegacyActionIcon>
    </Group>
  );
};
