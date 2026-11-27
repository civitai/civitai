import { IconWallpaper } from '@tabler/icons-react';
import { Menu } from '~/components/MantineOverlays';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** "Set as background" for one of the owner's images: members only, behind the profile redesign. */
export function useSetProfileBackground() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const mutation = trpc.userProfile.setBackground.useMutation({
    onSuccess: async () => {
      await utils.userProfile.customization.invalidate();
      showSuccessNotification({ message: 'Set as your page background' });
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not set your background',
        error: new Error(error.message),
      }),
  });
  return {
    available: !!features.profileRedesign && !!currentUser?.isPaidMember,
    setBackground: (imageId: number) => mutation.mutate({ imageId }),
    isPending: mutation.isPending,
  };
}

/** Checks the flag and membership before mounting the mutation: image menus render by the hundred. */
export function SetAsBackgroundMenuItem({ imageId }: { imageId: number }) {
  const features = useFeatureFlags();
  if (!features.profileRedesign) return null;
  return <MemberOnly imageId={imageId} />;
}

function MemberOnly({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  if (!currentUser?.isPaidMember) return null;
  return <SetAsBackgroundItem imageId={imageId} />;
}

function SetAsBackgroundItem({ imageId }: { imageId: number }) {
  const { setBackground } = useSetProfileBackground();
  return (
    <Menu.Item
      leftSection={<IconWallpaper size={14} stroke={1.5} />}
      onClick={() => setBackground(imageId)}
    >
      Set as profile background
    </Menu.Item>
  );
}
