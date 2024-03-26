import { Button, ButtonProps, Menu } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { MouseEventHandler } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';

import { showSuccessNotification } from '~/utils/notifications';

export function HideImageButton({ imageId, as = 'button', onToggleHide, ...props }: Props) {
  const images = useHiddenPreferencesData().hiddenImages;
  const hiddenImages = images.filter((x) => x.hidden);
  const alreadyHiding = hiddenImages.some((x) => x.id === imageId);

  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleHideClick: MouseEventHandler<HTMLElement> = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleHiddenMutation.mutateAsync({ kind: 'image', data: [{ id: imageId }] }).then(() => {
      showSuccessNotification({
        title: `Image ${alreadyHiding ? 'unhidden' : 'hidden'}`,
        message: `This image will${alreadyHiding ? ' ' : ' not '}show up in your feed`,
      });
    });

    onToggleHide?.();
  };

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
        icon={
          alreadyHiding ? <IconEye size={16} stroke={1.5} /> : <IconEyeOff size={16} stroke={1.5} />
        }
      >
        {alreadyHiding ? 'Unhide ' : 'Hide '}this image
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  imageId: number;
  as?: 'menu-item' | 'button';
  onToggleHide?: () => void;
};
