import { Menu } from '~/components/MantineOverlays';
import { IconHeart } from '@tabler/icons-react';
import { openAddToShowcaseModal } from '~/components/Dialog/triggers/add-to-showcase';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ShowcaseSectionType } from '~/server/schema/user-profile.schema';
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

/** The top-of-profile showcase holds models and images only; articles go in sections. */
export const addsToTopShowcase = (entityType: ShowcaseEntityType) => entityType !== 'Article';

/** Asks which showcase section when the owner has sections of this type; else adds to the top showcase. */
export function useAddToShowcaseAction({ entityType, entityId, offerSections = true }: Props) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { add } = useAddToTopShowcase(entityType);

  const offersSections = offerSections && features.profileShowcases && !!currentUser;
  const { data: user, isLoading } = trpc.userProfile.get.useQuery(
    { username: currentUser?.username ?? '' },
    { enabled: offersSections }
  );
  const hasSections =
    offersSections && !!user?.profile?.showcaseSections?.some((s) => s.type === entityType);

  const addToShowcase = () => {
    if (hasSections && currentUser?.username)
      openAddToShowcaseModal({
        props: { entityType, entityId, username: currentUser.username },
      });
    else add(entityId);
  };

  return {
    addToShowcase,
    available: hasSections || addsToTopShowcase(entityType),
    // Until the sections load, a click can't tell which add it means.
    disabled: offersSections && isLoading,
  };
}

export function AddToShowcaseMenuItem(props: Props) {
  const { addToShowcase, available, disabled } = useAddToShowcaseAction(props);
  if (!available) return null;

  return (
    <Menu.Item
      leftSection={<IconHeart size={14} stroke={1.5} />}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        addToShowcase();
      }}
      key="add-to-showcase"
      disabled={disabled}
    >
      Add to Showcase
    </Menu.Item>
  );
}

export type ShowcaseEntityType = ShowcaseSectionType;
type Props = {
  entityType: ShowcaseEntityType;
  entityId: number;
  /** false: only the one-click top-showcase add, no section picker. */
  offerSections?: boolean;
};
