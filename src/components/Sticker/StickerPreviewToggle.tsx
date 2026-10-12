import { Button } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { useReactionSettingsContext } from '~/components/Reaction/ReactionSettingsProvider';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

/**
 * Hides every piece of placement chrome so the drafts on this image can be seen
 * the way they will look once placed, and brings it back.
 */
export function StickerPreviewToggle({
  imageId,
  className,
}: {
  imageId: number;
  className?: string;
}) {
  const { buttonStyling } = useReactionSettingsContext();
  const hasDrafts = useStickerPlacementDraftStore(
    (state) => state.targetImageId === imageId && state.drafts.length > 0
  );
  const previewing = useStickerPlacementDraftStore((state) => state.previewing);
  const setPreviewing = useStickerPlacementDraftStore((state) => state.setPreviewing);

  if (!hasDrafts) return null;

  const Icon = previewing ? IconEye : IconEyeOff;

  return (
    <Button
      size="compact-sm"
      radius="xl"
      variant="light"
      color="gray"
      leftSection={<Icon size={16} />}
      {...buttonStyling?.('AddReaction', previewing)}
      className={className}
      aria-pressed={previewing}
      onClick={() => setPreviewing(!previewing)}
    >
      {previewing ? 'Show controls' : 'Hide controls'}
    </Button>
  );
}
