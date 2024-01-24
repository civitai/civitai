import { ActionIcon, Group, Menu } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { ChatMemberStatus } from '@prisma/client';
import {
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

  const myMember = chatObj?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const isOwner = myMember?.isOwner === true;

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

          if (isDefined(req.status) && req.status !== ChatMemberStatus.Joined) {
            setState((prev) => ({ ...prev, existingChatId: undefined }));
            return old.filter((c) => c.id !== chatObj?.id);
          }

          const tChat = old.find((c) => c.id === chatObj?.id);
          const tMember = tChat?.chatMembers?.find((cm) => cm.userId === data.userId);
          if (!tMember) return old;

          tMember.isMuted = data.isMuted;
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

  const leaveChat = () => {
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
      status: ChatMemberStatus.Left,
    });
  };

  // TODO check leaving and then reopening a new chat with same people
  // TODO probably don't close modal until left
  const leaveModal = () =>
    openConfirmModal({
      title: 'Really leave this chat?',
      centered: true,
      labels: { confirm: 'Confirm', cancel: 'Cancel' },
      onConfirm: leaveChat,
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
              <Menu.Item
                icon={myMember?.isMuted ? <IconBell size={18} /> : <IconBellOff size={18} />}
                onClick={toggleNotifications}
              >{`${myMember?.isMuted ? 'Enable' : 'Disable'} notifications`}</Menu.Item>
              <Menu.Item icon={<IconFlag size={18} />} color="orange" onClick={reportModal}>
                Report
              </Menu.Item>
              <Menu.Item icon={<IconDoorExit size={18} />} color="red" onClick={leaveModal}>
                Leave
              </Menu.Item>
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
