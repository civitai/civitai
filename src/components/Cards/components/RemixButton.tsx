import { IconBrush } from '@tabler/icons-react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GetGenerationDataInput } from '~/server/schema/generation.schema';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useTrackEvent } from '~/components/TrackView/track.utils';

export function RemixButton({
  canGenerate,
  ...props
}: GetGenerationDataInput & { canGenerate: boolean }) {
  const features = useFeatureFlags();
  const { trackAction } = useTrackEvent();
  if (!features.imageGeneration || !canGenerate) return null;

  const isRemix =
    props.type === 'image' || props.type === 'video' || props.type === 'audio';

  const handleClick = () => {
    // Top-of-funnel telemetry. The component is named RemixButton but is
    // overloaded — ImageCard uses it as a remix entry-point (image/video/audio
    // source) while ModelCard uses it as a create entry-point (modelVersion).
    // Discriminate on the input type so the funnel can split them.
    //
    // Note: `props.id` is typed `unknown` here because `GetGenerationDataInput`
    // is the z.input<> of a `z.coerce.number()` schema — it accepts any
    // coercible value. By the time this component renders the parent has
    // already passed a number; `Number(...)` is a safe normalize. We narrow
    // first with isFinite to avoid logging NaN if a caller ever passes junk.
    if (isRemix && 'id' in props) {
      const imageId = Number(props.id);
      if (Number.isFinite(imageId)) {
        trackAction({
          type: 'Image_Remix_Click',
          details: {
            imageId,
            imageType: props.type,
            // RemixButton is rendered by Cards/ImageCard.tsx — HomeBlocks,
            // Profile sections, ImageRemixOf details. `remix:image-card` is
            // already used by Image/Infinite/ImagesCard.tsx, so we use a
            // distinguishing tag here.
            source: 'remix:image-card-home',
          },
        }).catch(() => undefined);
      }
    } else if (props.type === 'modelVersion') {
      const modelVersionId = Number(props.id);
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
    }

    generationGraphPanel.open(props);
  };

  return (
    <HoverActionButton
      label={isRemix ? 'Remix' : 'Create'}
      size={30}
      color="white"
      variant="filled"
      data-activity={isRemix ? 'remix:image-card-home' : 'create:model-card'}
      onClick={handleClick}
    >
      <IconBrush stroke={2.5} size={16} />
    </HoverActionButton>
  );
}
