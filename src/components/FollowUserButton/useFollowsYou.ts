import { deriveHiddenUsers } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
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

type UserRef = { id: number };

// Unlike the feed, moderators are not exempt: `getFollowsViewer` has no moderator exemption either.
export function ownListBlockRelations(hidden: {
  hiddenUsers: UserRef[];
  blockedUsers: UserRef[];
  blockedByUsers: UserRef[];
}) {
  return deriveHiddenUsers(hidden, false).blockRelations;
}

/**
 * Everyone on your own followers list follows you, so the list needs no request. A block in
 * either direction still suppresses it, as `getFollowsViewer` does on the server, moderators
 * included. Until hidden preferences load the blocks are unknown, so nobody is labelled.
 */
export function ownFollowerFollowsYou({
  isOwnList,
  userId,
  hiddenLoaded,
  blockRelations,
}: {
  isOwnList: boolean;
  userId: number;
  hiddenLoaded: boolean;
  blockRelations: Map<number, boolean>;
}) {
  return isOwnList && hiddenLoaded && !blockRelations.has(userId);
}

/**
 * `followsYou: true` is for surfaces that already know the answer, and never fetches.
 * `checkFollowsYou` asks the server, once, and only when the answer can change the label.
 */
export function useFollowButtonState({
  userId,
  followsYou: knownFollowsYou,
  checkFollowsYou,
}: {
  userId: number;
  followsYou?: boolean;
  checkFollowsYou?: boolean;
}) {
  const currentUser = useCurrentUser();
  const isOther = !!currentUser && currentUser.id !== userId;

  const { data: followingIds = [], isSuccess: followingLoaded } =
    trpc.user.getFollowingUsers.useQuery(undefined, { enabled: !!currentUser });
  const following = followingIds.includes(userId);

  const { data: fetched = false } = trpc.user.getFollowsMe.useQuery(
    { id: userId },
    { enabled: !!checkFollowsYou && !knownFollowsYou && isOther && followingLoaded && !following }
  );

  // Gated again here, not only in `enabled`: a disabled query still returns whatever another
  // surface cached for the same id.
  const followsYou = isOther && (!!knownFollowsYou || (!!checkFollowsYou && fetched));

  return { following, label: followButtonLabel({ following, followsYou }) };
}
