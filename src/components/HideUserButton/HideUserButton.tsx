import type { ButtonProps } from '@mantine/core';
import { Button, Menu } from '@mantine/core';
import { IconUser, IconUserOff } from '@tabler/icons-react';
import type { MouseEventHandler } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showSuccessNotification } from '~/utils/notifications';

export function HideUserButton({ userId, as = 'button', onToggleHide, ...props }: Props) {
  const currentUser = useCurrentUser();

  const users = useHiddenPreferencesData().hiddenUsers;
  const alreadyHiding = users.some((x) => x.id === userId);
  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleHideClick: MouseEventHandler<HTMLElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();

    toggleHiddenMutation
      .mutateAsync({
        kind: 'user',
        data: [{ id: userId }],
        hidden: !alreadyHiding,
      })
      .then(() => {
        showSuccessNotification({
          title: `User marked as ${alreadyHiding ? 'show' : 'hidden'}`,
          message: `Content from this user will${
            alreadyHiding ? ' ' : ' not'
          } show up in your feed`,
        });
      });

    onToggleHide?.();
  };

  if (currentUser != null && userId === currentUser.id) return null;

  return as === 'button' ? (
    <LoginRedirect reason="hide-content">
      <Button
        variant={alreadyHiding ? 'outline' : 'filled'}
        onClick={handleHideClick}
        loading={toggleHiddenMutation.isLoading}
        {...props}
      >
        {alreadyHiding ? 'Unhide' : 'Hide'}
      </Button>
    </LoginRedirect>
  ) : (
    <LoginRedirect reason="hide-content">
      <Menu.Item
        onClick={handleHideClick}
        leftSection={
          alreadyHiding ? (
            <IconUser size={16} stroke={1.5} />
          ) : (
            <IconUserOff size={16} stroke={1.5} />
          )
        }
      >
        {alreadyHiding ? 'Unhide ' : 'Hide '}content from this user
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  userId: number;
  as?: 'menu-item' | 'button';
  onToggleHide?: () => void;
};
