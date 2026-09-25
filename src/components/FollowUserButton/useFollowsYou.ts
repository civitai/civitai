import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function followButtonLabel({
  following,
  followsYou,
}: {
  following: boolean;
  followsYou: boolean;
}) {
  if (following) return 'Unfollow';
  return followsYou ? 'Follow back' : 'Follow';
}

/**
 * `followsYou: true` is for surfaces that already know the answer (your own followers list), and
 * never fetches. `checkFollowsYou` asks the server, once, and only when the answer can change the
 * label.
 */
export function useFollowsYou({
  userId,
  following,
  followingLoaded,
  followsYou,
  checkFollowsYou,
}: {
  userId: number;
  following: boolean;
  followingLoaded: boolean;
  followsYou?: boolean;
  checkFollowsYou?: boolean;
}) {
  const currentUser = useCurrentUser();
  const enabled =
    !!checkFollowsYou &&
    !followsYou &&
    !!currentUser &&
    currentUser.id !== userId &&
    followingLoaded &&
    !following;

  const { data: fetched = false } = trpc.user.getFollowsMe.useQuery({ id: userId }, { enabled });

  if (!currentUser || currentUser.id === userId) return false;
  return !!followsYou || (!!checkFollowsYou && fetched);
}
