import { IconBrush } from '@tabler/icons-react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RemixMenu, isRemixMenuVisible } from '~/components/Image/Remix/RemixMenu';
import type { RemixSourceImage } from '~/components/Image/Remix/remix.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/** Remix entry-point for the compact media cards (home blocks, profile sections). */
export function CardRemixButton({ image }: { image: RemixSourceImage }) {
  const features = useFeatureFlags();
  if (!features.imageGeneration || !isRemixMenuVisible(image)) return null;

  return (
    <RemixMenu image={image} source="remix:image-card-home">
      <HoverActionButton
        label="Remix"
        size={30}
        color="white"
        variant="filled"
        data-activity="remix:image-card-home"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <IconBrush stroke={2.5} size={16} />
      </HoverActionButton>
    </RemixMenu>
  );
}
