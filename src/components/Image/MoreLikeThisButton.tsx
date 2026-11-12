import { IconPhotoSearch } from '@tabler/icons-react';
import Router from 'next/router';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { MediaType } from '~/shared/utils/prisma/enums';

type MoreLikeThisImage = { id: number; type: MediaType | `${MediaType}` };

/** Only images are embedded, so videos have no "more like this". */
export function isMoreLikeThisVisible(
  features: Pick<FeatureAccess, 'imageSearch'>,
  image: MoreLikeThisImage
) {
  return !!features.imageSearch && image.type === MediaType.image;
}

export const moreLikeThisHref = (imageId: number) => `/search/images?similarTo=${imageId}`;

/** Opens image search with the images that look like this one. */
export function MoreLikeThisButton({ image }: { image: MoreLikeThisImage }) {
  const features = useFeatureFlags();
  if (!isMoreLikeThisVisible(features, image)) return null;

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
        void Router.push(moreLikeThisHref(image.id));
      }}
    >
      <IconPhotoSearch stroke={2.5} size={16} />
    </HoverActionButton>
  );
}
