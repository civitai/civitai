import { ActionIcon, Group, Menu } from '@mantine/core';
import { ChatMemberStatus } from '@prisma/client';
import {
  IconBell,
  IconBellOff,
  IconDoorExit,
  IconEar,
  IconFlag,
  IconSettings,
  IconUserPlus,
  IconUserX,
  IconX,
} from '@tabler/icons-react';
import produce from 'immer';
import React, { Dispatch, SetStateAction } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChatListMessage } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const ChatActions = ({
  setOpened,
  setNewChat,
  setExistingChat,
  chatObj,
}: {
  setOpened: Dispatch<SetStateAction<boolean>>;
  setNewChat: Dispatch<SetStateAction<boolean>>;
  setExistingChat: Dispatch<SetStateAction<number | undefined>>;
  chatObj?: ChatListMessage;
}) => {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const myMember = chatObj?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const isOwner = myMember?.isOwner === true;

  const { mutate: modifyMembership } = trpc.chat.modifyUser.useMutation({
    onSuccess(data, req) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          if (isDefined(req.status) && req.status !== ChatMemberStatus.Joined) {
            setExistingChat(undefined);
            setNewChat(true);
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
              {isOwner && <Menu.Item icon={<IconUserPlus size={18} />}>Add users</Menu.Item>}
              {isOwner && <Menu.Item icon={<IconUserX size={18} />}>Ban users</Menu.Item>}
              <Menu.Item
                icon={myMember?.isMuted ? <IconBell size={18} /> : <IconBellOff size={18} />}
                onClick={toggleNotifications}
              >{`${myMember?.isMuted ? 'Enable' : 'Disable'} notifications`}</Menu.Item>
              <Menu.Item icon={<IconFlag size={18} />} color="orange">
                Report
              </Menu.Item>
              <Menu.Item icon={<IconDoorExit size={18} />} color="red" onClick={leaveChat}>
                Leave
              </Menu.Item>
            </>
          )}
          <Menu.Label>Global</Menu.Label>
          <Menu.Item icon={<IconEar size={18} />}>Mute/play sounds</Menu.Item>
          {/* TODO blocklist here? */}
          {/*<Menu.Item>Manage blocklist</Menu.Item>*/}
        </Menu.Dropdown>
      </Menu>
      <ActionIcon onClick={() => setOpened(false)}>
        <IconX />
      </ActionIcon>
    </Group>
  );
};
