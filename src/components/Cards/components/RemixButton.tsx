import { IconBrush } from '@tabler/icons-react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useTrackEvent } from '~/components/TrackView/track.utils';

/**
 * "Create" entry-point on a model card. Media cards use `CardRemixButton`,
 * which opens the remix menu rather than seeding the form directly.
 */
export function RemixButton({ canGenerate, id }: { id: number; canGenerate: boolean }) {
  const features = useFeatureFlags();
  const { trackAction } = useTrackEvent();
  if (!features.imageGeneration || !canGenerate) return null;

  const handleClick = () => {
    const modelVersionId = Number(id);
    if (Number.isFinite(modelVersionId)) {
      // Note: modelId is intentionally omitted — the ModelCard caller
      // doesn't have ModelVersion.modelId in scope here. Dashboard queries
      // wanting parent-model rollups should JOIN through ModelVersion.
      // Documented in the Model_Create_Click schema doc-block as
      // 'create:model-card emits without modelId'.
      trackAction({
        type: 'Model_Create_Click',
        details: {
          modelVersionId,
          source: 'create:model-card',
        },
      }).catch(() => undefined);
    }

    generationGraphPanel.open({ type: 'modelVersion', id });
  };

  return (
    <HoverActionButton
      label="Create"
      size={30}
      color="white"
      variant="filled"
      data-activity="create:model-card"
      onClick={handleClick}
    >
      <IconBrush stroke={2.5} size={16} />
    </HoverActionButton>
  );
}
