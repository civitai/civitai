import { IconLayoutGridRemove } from '@tabler/icons-react';
import { Menu } from '~/components/MantineOverlays';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * For the image's author: takes it out of every model showcase that features it. Shown only when
 * it is featured somewhere, and available whatever the feature flag says.
 */
export function RemoveFromVersionShowcasesMenuItem({ imageId }: { imageId: number }) {
  const utils = trpc.useUtils();
  const { data: features = [] } = trpc.versionShowcase.getMyImageFeatures.useQuery({ imageId });
  const removeMine = trpc.versionShowcase.removeMine.useMutation();
  const versionIds = [...new Set(features.map((feature) => feature.modelVersionId))];
  if (!versionIds.length) return null;

  const handleClick = async () => {
    try {
      for (const modelVersionId of versionIds)
        await removeMine.mutateAsync({ modelVersionId, imageId });
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
