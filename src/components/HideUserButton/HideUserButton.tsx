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

  const { hiddenUsers, blockedUsers } = useHiddenPreferencesData();
  const alreadyHiding = hiddenUsers.some((x) => x.id === userId);
  const blocked = blockedUsers.some((x) => x.id === userId);
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
      .then(({ hidden }) => {
        // The server refuses a hide it ranks below an existing block, so report its
        // outcome rather than the one we asked for.
        const nowHidden = hidden ?? !alreadyHiding;
        showSuccessNotification({
          title: `User marked as ${nowHidden ? 'hidden' : 'show'}`,
          message: `Content from this user will${nowHidden ? ' not' : ''} show up in your feed`,
        });
      });

    onToggleHide?.();
  };

  if (currentUser != null && userId === currentUser.id) return null;
  // Block outranks Hide, so the server refuses a hide over one and this control
  // would report a change it cannot make.
  if (blocked) return null;

  return as === 'button' ? (
    <LoginRedirect reason="hide-content">
      <Button
        variant={alreadyHiding ? 'outline' : 'filled'}
        onClick={handleHideClick}
        loading={toggleHiddenMutation.isPending}
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
