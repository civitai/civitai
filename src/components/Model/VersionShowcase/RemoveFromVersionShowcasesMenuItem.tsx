import { IconLayoutGridRemove } from '@tabler/icons-react';
import { Menu } from '~/components/MantineOverlays';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Takes an image out of every model showcase that features it, for its author or, as a moderator,
 * for anyone's image. Either way the creator can't feature it again. Available whatever the
 * feature flag says.
 */
export function RemoveFromVersionShowcasesMenuItem({
  imageId,
  asModerator = false,
}: {
  imageId: number;
  asModerator?: boolean;
}) {
  const utils = trpc.useUtils();
  const { data: features = [] } = trpc.versionShowcase.getMyImageFeatures.useQuery({ imageId });
  const removeMine = trpc.versionShowcase.removeMine.useMutation();
  const moderatorRemove = trpc.versionShowcase.moderatorRemove.useMutation();
  const remove = asModerator ? moderatorRemove : removeMine;
  const versionIds = [...new Set(features.map((feature) => feature.modelVersionId))];
  if (!versionIds.length) return null;

  const handleClick = async () => {
    try {
      for (const modelVersionId of versionIds)
        await remove.mutateAsync({ modelVersionId, imageId });
      await utils.versionShowcase.getMyImageFeatures.invalidate({ imageId });
      showSuccessNotification({ message: 'Removed from model showcases' });
    } catch (error) {
      showErrorNotification({ title: 'Could not remove it', error: error as Error });
    }
  };

  const modelNames = [...new Set(features.map((feature) => feature.modelName))];
  return (
    <Menu.Item
      leftSection={<IconLayoutGridRemove size={14} stroke={1.5} />}
      onClick={handleClick}
      title={modelNames.join(', ')}
    >
      Remove from{' '}
      {versionIds.length === 1 ? 'a model showcase' : `${versionIds.length} model showcases`}
    </Menu.Item>
  );
}
