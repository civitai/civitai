import { Button, Tooltip } from '@mantine/core';
import type { ButtonProps } from '@mantine/core';
import { IconBookmark, IconBookmarkFilled } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';

/**
 * The followed list, plus the two writes over it. Shared by the button and the rail
 * section so both read one query cache entry: the button's own state is "is this hub
 * in my list", not a second per-hub lookup.
 */
export function useHubFollows() {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const invalidate = () => utils.userHub.getFollowed.invalidate();

  const { data: followed = [], isLoading } = trpc.userHub.getFollowed.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const onError = (title: string) => (error: { message: string }) =>
    showErrorNotification({ title, error: new Error(error.message) });

  const follow = trpc.userHub.follow.useMutation({
    onSuccess: invalidate,
    onError: onError('Could not follow this hub'),
  });
  const unfollow = trpc.userHub.unfollow.useMutation({
    onSuccess: invalidate,
    onError: onError('Could not unfollow this hub'),
  });

  return {
    followed,
    isLoading,
    isFollowing: (hubId: number) => followed.some((hub) => hub.id === hubId),
    pending: follow.isPending || unfollow.isPending,
    follow: (hubId: number) => follow.mutate({ hubId }),
    unfollow: (hubId: number) => unfollow.mutate({ hubId }),
  };
}

export function FollowHubButton({
  hub,
  iconOnly,
  ...props
}: {
  hub: { id: number; isOwner: boolean };
  /** Render as a bare action icon with a tooltip, for a crowded header row. */
  iconOnly?: boolean;
} & Pick<ButtonProps, 'size' | 'fullWidth' | 'className'>) {
  const currentUser = useCurrentUser();
  const { isFollowing, pending, follow, unfollow } = useHubFollows();

  // Nothing rendered at all for the owner, rather than a disabled control: your own
  // hubs are already the list above this one in the rail, so there is no state a
  // follow button here could put you in.
  if (!currentUser || hub.isOwner) return null;

  const following = isFollowing(hub.id);

  const label = following ? 'Following' : 'Follow';
  const icon = following ? <IconBookmarkFilled size={18} /> : <IconBookmark size={18} />;

  // Icon only where the label would compete with the hub's own title for the row.
  if (iconOnly)
    return (
      <Tooltip label={label} withinPortal>
        <LegacyActionIcon
          variant={following ? 'light' : 'subtle'}
          // Colour, not just fill: a lit grey icon reads as hover, and following is a
          // state you should be able to spot without pointing at it.
          color={following ? 'blue' : 'gray'}
          loading={pending}
          aria-label={label}
          onClick={() => (following ? unfollow(hub.id) : follow(hub.id))}
        >
          {icon}
        </LegacyActionIcon>
      </Tooltip>
    );

  return (
    <Button
      variant={following ? 'light' : 'filled'}
      loading={pending}
      leftSection={icon}
      onClick={() => (following ? unfollow(hub.id) : follow(hub.id))}
      {...props}
    >
      {label}
    </Button>
  );
}
