import { IconPin, IconPinnedOff } from '@tabler/icons-react';
import { Menu } from '~/components/MantineOverlays';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { profilePinnedItemsLimit } from '~/server/schema/user-profile.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type PinnableType = 'Image' | 'Model';

/**
 * "Pin to profile" / "Unpin from profile" for one of the owner's images or models, shown on their
 * About tab (profile redesign). Checks the flag before reading the session: menus render by the
 * hundred, some without a session in tests.
 */
export function PinToProfileMenuItem(props: { entityType: PinnableType; entityId: number }) {
  const features = useFeatureFlags();
  if (!features.profileRedesign) return null;
  return <PinItem {...props} />;
}

function PinItem({ entityType, entityId }: { entityType: PinnableType; entityId: number }) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const userId = currentUser?.id ?? 0;
  const { data } = trpc.userProfile.about.useQuery({ userId }, { enabled: !!userId });
  const pinned = !!data?.pinnedItems.some(
    (item) => item.entityType === entityType && item.entityId === entityId
  );
  const full = !pinned && (data?.pinnedItems.length ?? 0) >= profilePinnedItemsLimit;
  const mutation = trpc.userProfile.setPinned.useMutation({
    onSuccess: async (_, input) => {
      await utils.userProfile.about.invalidate({ userId });
      showSuccessNotification({
        message: input.pinned ? 'Pinned to your About tab' : 'Unpinned from your About tab',
      });
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not change your pins',
        error: new Error(error.message),
      }),
  });
  if (!userId) return null;

  return (
    <Menu.Item
      leftSection={
        pinned ? <IconPinnedOff size={14} stroke={1.5} /> : <IconPin size={14} stroke={1.5} />
      }
      disabled={full}
      onClick={() => mutation.mutate({ entityType, entityId, pinned: !pinned })}
    >
      {pinned
        ? 'Unpin from profile'
        : full
        ? `Pin to profile (${profilePinnedItemsLimit} pinned already)`
        : 'Pin to profile'}
    </Menu.Item>
  );
}
