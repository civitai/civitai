import { Button, ButtonProps, Menu } from '@mantine/core';
import { IconUser, IconUserOff } from '@tabler/icons-react';
import { MouseEventHandler, useState } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferences } from '~/providers/HiddenPreferencesProvider';
import { hiddenPreferences } from '~/store/hidden-preferences.store';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function HideUserButton({ userId, as = 'button', onToggleHide, ...props }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { users: userHiddenUsers } = useHiddenPreferences();
  const alreadyHiding = userHiddenUsers.get(userId);
  const [loading, setLoading] = useState(false);

  const handleHideClick: MouseEventHandler<HTMLElement> = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (loading === true) return;
    setLoading(true);
    await hiddenPreferences.toggleEntity({ entityType: 'user', entityId: userId });
    setLoading(false);

    const prevHidden = queryUtils.user.getHiddenUsers.getData();
    queryUtils.user.getHiddenUsers.setData(undefined, (old = []) =>
      alreadyHiding
        ? old.filter((item) => item.id !== userId)
        : [...old, { id: userId, username: null, image: null, deletedAt: null }]
    );

    showSuccessNotification({
      title: `User marked as ${alreadyHiding ? 'show' : 'hidden'}`,
      message: `Content from this user will${alreadyHiding ? ' ' : ' not'} show up in your feed`,
    });

    onToggleHide?.();
  };

  if (currentUser != null && userId === currentUser.id) return null;

  return as === 'button' ? (
    <LoginRedirect reason="hide-content">
      <Button
        variant={alreadyHiding ? 'outline' : 'filled'}
        onClick={handleHideClick}
        loading={loading}
        {...props}
      >
        {alreadyHiding ? 'Unhide' : 'Hide'}
      </Button>
    </LoginRedirect>
  ) : (
    <LoginRedirect reason="hide-content">
      <Menu.Item
        onClick={handleHideClick}
        icon={
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
