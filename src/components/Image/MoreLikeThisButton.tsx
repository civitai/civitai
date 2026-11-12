import { IconPhotoSearch } from '@tabler/icons-react';
import Router from 'next/router';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { MediaType } from '~/shared/utils/prisma/enums';

/** Opens image search with the images that look like this one. Only images are embedded. */
export function MoreLikeThisButton({ image }: { image: { id: number; type: MediaType } }) {
  const features = useFeatureFlags();
  if (!features.imageSearch || image.type !== MediaType.image) return null;

  return (
    <HoverActionButton
      label="More like this"
      size={30}
      color="white"
      variant="filled"
      data-activity="search:more-like-this"
      onClick={(e) => {
        // The card itself links to the image detail.
        e.preventDefault();
        e.stopPropagation();
        void Router.push(`/search/images?similarTo=${image.id}`);
      }}
    >
      <IconPhotoSearch stroke={2.5} size={16} />
    </HoverActionButton>
  );
}
