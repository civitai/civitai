import { ActionIcon, Group, Menu, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { ChatMemberStatus } from '@prisma/client';
import {
  IconArrowsJoin2,
  IconBell,
  IconBellOff,
  IconDoorExit,
  IconEar,
  IconEarOff,
  IconFlag,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import React from 'react';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const ChatActions = ({ chatObj }: { chatObj?: ChatListMessage }) => {
  const { setState } = useChatContext();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const userSettings = queryUtils.chat.getUserSettings.getData();
  // const { data: userSettings } = trpc.chat.getUserSettings.useQuery(undefined, { enabled: !!currentUser });
  // TODO if this works, more of this for getAllByUser
  const muteSounds = userSettings?.muteSounds ?? false;

  // const isOwner = myMember?.isOwner === true;
  const myMember = chatObj?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const modSender = chatObj?.chatMembers.find(
    (cm) => cm.userId !== currentUser?.id && cm.isOwner === true && cm.user.isModerator === true
  );
  const cantLeave = modSender?.status === ChatMemberStatus.Joined && !myMember?.user.isModerator;

  const { mutate: modifySettings } = trpc.chat.setUserSettings.useMutation({
    onSuccess(data) {
      queryUtils.chat.getUserSettings.setData(undefined, (old) => {
        if (!old) return old;
        return data;
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update settings.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

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

  const handleMute = () => {
    modifySettings({
      muteSounds: !muteSounds,
    });
  };

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
    openContext('report', {
      entityType: ReportEntity.Chat,
      entityId: chatObj.id,
    });
  };

  return (
    <Group>
      <Menu withArrow position="bottom-end">
        <Menu.Target>
          <ActionIcon>
            <IconSettings />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {!!chatObj && (
            <>
              <Menu.Label>Chat Actions</Menu.Label>
              {/*TODO enable these*/}
              {/*{isOwner && <Menu.Item icon={<IconUserPlus size={18} />}>Add users</Menu.Item>}*/}
              {/*{isOwner && <Menu.Item icon={<IconUserX size={18} />}>Ban users</Menu.Item>}*/}
              {myMember?.status === ChatMemberStatus.Joined && (
                <Menu.Item
                  icon={myMember?.isMuted ? <IconBell size={18} /> : <IconBellOff size={18} />}
                  onClick={toggleNotifications}
                >{`${myMember?.isMuted ? 'Enable' : 'Disable'} notifications`}</Menu.Item>
              )}
              <Menu.Item icon={<IconFlag size={18} />} color="orange" onClick={reportModal}>
                Report
              </Menu.Item>
              {myMember?.status === ChatMemberStatus.Joined ? (
                <Tooltip
                  label={
                    cantLeave
                      ? 'Cannot leave a moderator chat while they are still present'
                      : undefined
                  }
                >
                  <Menu.Item
                    icon={<IconDoorExit size={18} />}
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
                  icon={<IconArrowsJoin2 size={18} />}
                  color="green"
                  onClick={() => adjustChat(ChatMemberStatus.Joined)}
                >
                  Rejoin
                </Menu.Item>
              ) : undefined}
            </>
          )}
          <Menu.Label>Global</Menu.Label>
          <Menu.Item
            icon={muteSounds ? <IconEar size={18} /> : <IconEarOff size={18} />}
            onClick={handleMute}
          >
            {`${muteSounds ? 'Play' : 'Mute'} sounds`}
          </Menu.Item>
          {/* TODO blocklist here? */}
          {/*<Menu.Item>Manage blocklist</Menu.Item>*/}
        </Menu.Dropdown>
      </Menu>
      <ActionIcon onClick={() => setState((prev) => ({ ...prev, open: false }))}>
        <IconX />
      </ActionIcon>
    </Group>
  );
};
