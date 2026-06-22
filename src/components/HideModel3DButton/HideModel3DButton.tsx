import { trpc } from '~/utils/trpc';
import type { ButtonProps } from '@mantine/core';
import { Button, Menu } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import type { MouseEventHandler } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showSuccessNotification } from '~/utils/notifications';

/**
 * Hide / unhide a single Model3D from the current viewer's feed. Direct
 * counterpart to `HideModelButton` — same surface, different entity. Reads
 * the `hiddenModel3Ds` slice the user-preferences pipeline added.
 */
export function HideModel3DButton({
  model3dId,
  ownerUserId,
  as = 'button',
  onToggleHide,
  ...props
}: Props) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const model3ds = useHiddenPreferencesData().hiddenModel3Ds;
  const alreadyHiding = model3ds.some((x) => x.id === model3dId);

  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleHideClick: MouseEventHandler<HTMLElement> = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Mirror HideModelButton: keep the user's "Hidden" tab fresh when
    // they toggle one on (only relevant if a parallel hidden tab for
    // model3d exists; a no-op invalidate is safe regardless).
    if (!alreadyHiding) await utils.model3d.getInfinite.invalidate(undefined, { exact: false });
    toggleHiddenMutation
      .mutateAsync({ kind: 'model3d', data: [{ id: model3dId }] })
      .then(() => {
        showSuccessNotification({
          title: `3D model ${alreadyHiding ? 'unhidden' : 'hidden'}`,
          message: `This 3D model will${
            alreadyHiding ? ' ' : ' not '
          }show up in your feed`,
        });
      });
    onToggleHide?.();
  };

  // Don't surface the toggle to the owner — there's no sense in hiding
  // your own Model3D from your own feed.
  if (currentUser != null && ownerUserId === currentUser.id) return null;

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
        {alreadyHiding ? 'Unhide ' : 'Hide '}this 3D model
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  model3dId: number;
  /** Owner of the Model3D — used to suppress the toggle for self-views. */
  ownerUserId?: number;
  as?: 'menu-item' | 'button';
  onToggleHide?: () => void;
};
