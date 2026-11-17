import { Menu } from '~/components/MantineOverlays';
import { IconBook2 } from '@tabler/icons-react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import type { StorylineSparkImage } from '~/components/Storyline/StartStorylineModal';
import { openStartStorylineFromImageModal } from '~/components/Storyline/StartStorylineModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * "Start a story from this image" in an image's menu. Offered only where the image's remix gallery
 * is not switched off, since that is its creator's remix opt-out, and only with both the storylines
 * and remix gallery flags on. The server makes the same checks on create.
 *
 * Its query runs on mount, which is when the menu opens: `Menu.Dropdown` renders nothing until then
 * (see `RemixGalleryMenuItems`).
 */
export function StartStorylineFromImageMenuItem({ image }: { image: StorylineSparkImage }) {
  const features = useFeatureFlags();
  const enabled = !!features.storylines && !!features.remixGallery;
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const { data: visibility } = trpc.placement.getRemixGalleryVisibility.useQuery(
    { imageId: image.id, browsingLevel },
    { enabled }
  );

  if (!enabled || !visibility?.open) return null;

  return (
    <LoginRedirect reason="perform-action">
      <Menu.Item
        leftSection={<IconBook2 size={14} stroke={1.5} />}
        onClick={() => openStartStorylineFromImageModal(image)}
      >
        Start a story from this image
      </Menu.Item>
    </LoginRedirect>
  );
}
