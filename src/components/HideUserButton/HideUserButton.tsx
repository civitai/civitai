import { Menu, MenuItemProps } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SimpleUser } from '~/server/selectors/user.selector';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function HideUserButton({ user, onToggleHide, ...props }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: hidden = [] } = trpc.user.getHiddenUsers.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const alreadyHiding = hidden.map((user) => user.id).includes(user.id);

  const toggleHideMutation = trpc.user.toggleHide.useMutation({
    async onMutate() {
      await queryUtils.user.getHiddenUsers.cancel();

      const prevHidden = queryUtils.user.getHiddenUsers.getData();

      queryUtils.user.getHiddenUsers.setData(undefined, (old = []) =>
        alreadyHiding ? old.filter((item) => item.id !== user.id) : [...old, user]
      );

      return { prevHidden };
    },
    onSuccess() {
      showSuccessNotification({
        title: `User marked as ${alreadyHiding ? 'show' : 'hidden'}`,
        message: `Content from this user will${alreadyHiding ? ' ' : ' not'} show up in your feed`,
      });
    },
    onError(_error, _variables, context) {
      queryUtils.user.getHiddenUsers.setData(undefined, context?.prevHidden);
    },
    async onSettled() {
      await queryUtils.user.getHiddenUsers.invalidate();
      await queryUtils.user.getCreator.invalidate();
      await queryUtils.model.getAll.invalidate();
    },
  });
  const handleHideClick = () => {
    toggleHideMutation.mutate({ targetUserId: user.id });
    onToggleHide?.();
  };

  if (user.id === currentUser?.id) return null;

  return (
    <Menu.Item
      onClick={() => handleHideClick()}
      icon={
        alreadyHiding ? <IconEye size={16} stroke={1.5} /> : <IconEyeOff size={16} stroke={1.5} />
      }
      {...props}
    >
      {alreadyHiding ? 'Unhide ' : 'Hide '}content from this user
    </Menu.Item>
  );
}

type Props = Omit<MenuItemProps, 'onClick'> & {
  user: Omit<SimpleUser, 'name' | 'variant'>;
  onToggleHide?: () => void;
};
