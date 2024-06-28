import { Button, ButtonProps, Menu } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconUserCancel, IconUserCheck } from '@tabler/icons-react';
import { MouseEventHandler } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showSuccessNotification } from '~/utils/notifications';

export function BlockUserButton({ userId, as = 'button', onToggleHide, ...props }: Props) {
  const currentUser = useCurrentUser();

  const users = useHiddenPreferencesData().blockedUsers;
  const alreadyBlocking = users.some((x) => x.id === userId);
  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleBlockClick: MouseEventHandler<HTMLElement> = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (alreadyBlocking) {
      toggleHiddenMutation
        .mutateAsync({
          kind: 'blockedUser',
          data: [{ id: userId }],
          hidden: !alreadyBlocking,
        })
        .then(() => {
          showSuccessNotification({
            title: alreadyBlocking ? 'User unblocked' : 'blocked',
            message: `Content from this user will${
              alreadyBlocking ? ' ' : ' not'
            } show up in your feed`,
          });
        });
    } else {
      openConfirmModal({
        title: 'Block User',
        children: `Are you sure you want to block this user? Once a user is blocked, you won't see their content again and they won't see yours.`,
        labels: { confirm: 'Yes, block the user', cancel: 'Cancel' },
        confirmProps: { color: 'red' },
        onConfirm: () =>
          toggleHiddenMutation
            .mutateAsync({
              kind: 'blockedUser',
              data: [{ id: userId }],
              hidden: !alreadyBlocking,
            })
            .then(() => {
              showSuccessNotification({
                title: alreadyBlocking ? 'User unblocked' : 'blocked',
                message: `Content from this user will${
                  alreadyBlocking ? ' ' : ' not'
                } show up in your feed`,
              });
            }),
      });
    }

    onToggleHide?.();
  };

  if (currentUser != null && userId === currentUser.id) return null;

  return as === 'button' ? (
    <LoginRedirect reason="hide-content">
      <Button
        variant={alreadyBlocking ? 'outline' : 'filled'}
        onClick={handleBlockClick}
        loading={toggleHiddenMutation.isLoading}
        {...props}
      >
        {alreadyBlocking ? 'Unblock' : 'Block'}
      </Button>
    </LoginRedirect>
  ) : (
    <LoginRedirect reason="hide-content">
      <Menu.Item
        onClick={handleBlockClick}
        color={props.color}
        icon={
          alreadyBlocking ? (
            <IconUserCheck size={16} stroke={1.5} />
          ) : (
            <IconUserCancel size={16} stroke={1.5} />
          )
        }
      >
        {alreadyBlocking ? 'Unblock' : 'Block'} this user
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  userId: number;
  as?: 'menu-item' | 'button';
  onToggleHide?: () => void;
};
