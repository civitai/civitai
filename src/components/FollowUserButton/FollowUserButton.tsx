import { Button, ButtonProps } from '@mantine/core';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SimpleUser } from '~/server/selectors/user.selector';
import { trpc } from '~/utils/trpc';

export function FollowUserButton({ user, onToggleFollow, ...props }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: following = [] } = trpc.user.getFollowingUsers.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const alreadyFollowing = following.some((user) => user.id == user.id);

  const toggleFollowMutation = trpc.user.toggleFollow.useMutation({
    async onMutate() {
      await queryUtils.user.getFollowingUsers.cancel();

      const prevFollowing = queryUtils.user.getFollowingUsers.getData();

      queryUtils.user.getFollowingUsers.setData(undefined, (old = []) =>
        alreadyFollowing ? old.filter((item) => item.id !== user.id) : [...old, user]
      );

      return { prevFollowing };
    },
    onError(_error, _variables, context) {
      queryUtils.user.getFollowingUsers.setData(undefined, context?.prevFollowing);
    },
    async onSettled() {
      await queryUtils.user.getFollowingUsers.invalidate();
      await queryUtils.user.getCreator.invalidate();
    },
  });
  const handleFollowClick = () => {
    toggleFollowMutation.mutate({ targetUserId: user.id });
    onToggleFollow?.();
  };

  if (user.id === currentUser?.id) return null;

  return (
    <LoginRedirect reason="follow-user">
      <Button
        variant={alreadyFollowing ? 'outline' : 'filled'}
        onClick={() => handleFollowClick()}
        loading={toggleFollowMutation.isLoading}
        {...props}
      >
        {alreadyFollowing ? 'Unfollow' : 'Follow'}
      </Button>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  user: Omit<SimpleUser, 'name'>;
  onToggleFollow?: () => void;
};
