import { Button, ButtonProps, Menu } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons';
import { MouseEventHandler } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function HideModelButton({ modelId, as = 'button', onToggleHide, ...props }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: { Hide: hidden = [] } = { Hide: [] } } = trpc.user.getEngagedModels.useQuery(
    undefined,
    { enabled: !!currentUser }
  );
  const alreadyHiding = hidden.includes(modelId);

  const toggleHideMutation = trpc.user.toggleHideModel.useMutation({
    async onMutate() {
      await queryUtils.user.getEngagedModels.cancel();

      const prevEngaged = queryUtils.user.getEngagedModels.getData();

      // Toggle the model in the Hide list
      queryUtils.user.getEngagedModels.setData(
        undefined,
        ({ Hide = [], ...old } = { Favorite: [], Hide: [] }) => {
          if (alreadyHiding) return { Hide: Hide.filter((id) => id !== modelId), ...old };
          return { Hide: [...Hide, modelId], ...old };
        }
      );

      return { prevEngaged };
    },
    onSuccess() {
      showSuccessNotification({
        title: `Model ${alreadyHiding ? 'unhidden' : 'hidden'}`,
        message: `This model will${alreadyHiding ? ' ' : ' not '}show up in your feed`,
      });
    },
    onError(_error, _variables, context) {
      queryUtils.user.getEngagedModels.setData(undefined, context?.prevEngaged);
    },
  });
  const handleHideClick: MouseEventHandler<HTMLElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleHideMutation.mutate({ modelId });
    onToggleHide?.();
  };

  if (currentUser != null && modelId === currentUser.id) return null;

  return as === 'button' ? (
    <LoginRedirect reason="hide-content">
      <Button
        variant={alreadyHiding ? 'outline' : 'filled'}
        onClick={handleHideClick}
        loading={toggleHideMutation.isLoading}
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
        {alreadyHiding ? 'Unhide ' : 'Hide '}this model
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  modelId: number;
  as?: 'menu-item' | 'button';
  onToggleHide?: () => void;
};
