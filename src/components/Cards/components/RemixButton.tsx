import { IconBrush } from '@tabler/icons-react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GetGenerationDataInput } from '~/server/schema/generation.schema';
import { generationPanel } from '~/store/generation.store';

export function RemixButton({
  canGenerate,
  ...props
}: GetGenerationDataInput & { canGenerate: boolean }) {
  const features = useFeatureFlags();
  if (!features.imageGeneration || !canGenerate) return null;
  return (
    <HoverActionButton
      label="Create"
      size={30}
      color="white"
      variant="filled"
      data-activity="create:model-card"
      onClick={(e) => {
        generationPanel.open(props);
      }}
    >
      <IconBrush stroke={2.5} size={16} />
    </HoverActionButton>
  );
}
