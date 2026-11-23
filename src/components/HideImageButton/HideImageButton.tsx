import type { ButtonProps } from '@mantine/core';
import { Button } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import type { MouseEventHandler } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';

import { showSuccessNotification } from '~/utils/notifications';

export function HideImageButton({
  imageId,
  as = 'button',
  onToggleHide,
  noun = 'image',
  ...props
}: Props) {
  const images = useHiddenPreferencesData().hiddenImages;
  const hiddenImages = images.filter((x) => x.hidden);
  const alreadyHiding = hiddenImages.some((x) => x.id === imageId);

  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleHideClick: MouseEventHandler<HTMLElement> = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleHiddenMutation.mutateAsync({ kind: 'image', data: [{ id: imageId }] }).then(() => {
      showSuccessNotification({
        title: `${noun[0].toUpperCase()}${noun.slice(1)} ${alreadyHiding ? 'unhidden' : 'hidden'}`,
        message: `This ${noun} will${alreadyHiding ? ' ' : ' not '}show up in your feed`,
      });
    });

    onToggleHide?.();
  };

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
          alreadyHiding ? <IconEye size={16} stroke={1.5} /> : <IconEyeOff size={16} stroke={1.5} />
        }
      >
        {alreadyHiding ? 'Unhide ' : 'Hide '}this {noun}
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  imageId: number;
  as?: 'menu-item' | 'button';
  onToggleHide?: () => void;
  /** What the menu item and its notification call the item: "Hide this song". */
  noun?: string;
};
