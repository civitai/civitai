import { Menu } from '~/components/MantineOverlays';
import { IconHeart } from '@tabler/icons-react';
import { openAddToShowcaseModal } from '~/components/Dialog/triggers/add-to-showcase';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

export function useAddToTopShowcase(entityType: Props['entityType']) {
  const utils = trpc.useUtils();
  const mutation = trpc.userProfile.addEntityToShowcase.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `${entityType} has been added to showcase` });

      try {
        await utils.userProfile.get.invalidate();
      } catch (error) {
        // Ignore, user must've not had the query loaded.
      }
    },
  });

  /** Resolves whether it was added. */
  const add = (entityId: number) =>
    mutation
      .mutateAsync({ entityType, entityId })
      .then(() => true)
      .catch((error) => {
        showErrorNotification({
          title: 'Unable to add to showcase',
          error: new Error(error.message),
        });
        return false;
      });

  return { add, isPending: mutation.isPending };
}

export function AddToShowcaseMenuItem({ entityType, entityId }: Props) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { add } = useAddToTopShowcase(entityType);

  const offersSections = entityType === 'Image' && features.profileShowcases && !!currentUser;
  const { data: user, isLoading } = trpc.userProfile.get.useQuery(
    { username: currentUser?.username ?? '' },
    { enabled: offersSections }
  );
  const hasImageSections =
    offersSections && !!user?.profile?.showcaseSections?.some((s) => s.type === 'Image');

  const onClick = () => {
    if (hasImageSections && currentUser?.username)
      openAddToShowcaseModal({ props: { imageId: entityId, username: currentUser.username } });
    else add(entityId);
  };

  return (
    <Menu.Item
      leftSection={<IconHeart size={14} stroke={1.5} />}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      key="add-to-showcase"
      // Until the sections load, a click can't tell which add it means.
      disabled={offersSections && isLoading}
    >
      Add to Showcase
    </Menu.Item>
  );
}

type Props = { entityType: 'Model' | 'Image'; entityId: number };
