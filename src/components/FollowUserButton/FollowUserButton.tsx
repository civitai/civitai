import { Button, ButtonProps } from '@mantine/core';
import { MouseEventHandler } from 'react';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function FollowUserButton({ userId, onToggleFollow, ...props }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: following = [] } = trpc.user.getFollowingUsers.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const alreadyFollowing = following.some((user) => userId == user.id);

  const toggleFollowMutation = trpc.user.toggleFollow.useMutation({
    async onMutate() {
      await queryUtils.user.getFollowingUsers.cancel();

      const prevFollowing = queryUtils.user.getFollowingUsers.getData();

      queryUtils.user.getFollowingUsers.setData(undefined, (old = []) =>
        alreadyFollowing
          ? old.filter((item) => item.id !== userId)
          : [...old, { id: userId, username: null, image: null, deletedAt: null }]
      );

      const creatorCacheKey = { id: userId };
      const prevCreator = queryUtils.user.getCreator.getData(creatorCacheKey);
      queryUtils.user.getCreator.setData(creatorCacheKey, (old) => {
        if (!old || !old.stats) return old;
        return {
          ...old,
          stats: {
            ...old.stats,
            followerCountAllTime: alreadyFollowing
              ? old.stats.followerCountAllTime - 1
              : old.stats.followerCountAllTime + 1,
          },
        };
      });

      return { prevFollowing, prevCreator };
    },
    onError(_error, _variables, context) {
      queryUtils.user.getFollowingUsers.setData(undefined, context?.prevFollowing);
      queryUtils.user.getCreator.setData({ id: userId }, context?.prevCreator);
    },
    async onSettled() {
      await queryUtils.user.getFollowingUsers.invalidate();
      await queryUtils.user.getLists.invalidate();
    },
  });
  const handleFollowClick: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFollowMutation.mutate({ targetUserId: userId });
    onToggleFollow?.();
  };

  if (userId === currentUser?.id) return null;

  return (
    <LoginRedirect reason="follow-user">
      <Button
        variant={alreadyFollowing ? 'outline' : 'filled'}
        onClick={handleFollowClick}
        loading={toggleFollowMutation.isLoading}
        {...props}
      >
        {alreadyFollowing ? 'Unfollow' : 'Follow'}
      </Button>
    </LoginRedirect>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  userId: number;
  onToggleFollow?: () => void;
};
