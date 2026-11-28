import { IconPhotoSearch } from '@tabler/icons-react';
import Router from 'next/router';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { offersImageSearch } from '~/components/Search/search-target';
import { MediaType } from '~/shared/utils/prisma/enums';
import type { MoreLikeThisAnchor } from '~/shared/utils/more-like-this';
import { isMoreLikeThisRefused } from '~/shared/utils/more-like-this';

type MoreLikeThisImage = MoreLikeThisAnchor & {
  id: number;
  type: MediaType | `${MediaType}`;
};

type MoreLikeThisFlags = Pick<FeatureAccess, 'imageSearch' | 'feedSearch' | 'moreLikeThis'>;

export const offersMoreLikeThis = (features: MoreLikeThisFlags) =>
  !!features.moreLikeThis && offersImageSearch(features);

/** Only images are embedded, so videos have no "more like this". */
export function isMoreLikeThisVisible(features: MoreLikeThisFlags, image: MoreLikeThisImage) {
  return (
    offersMoreLikeThis(features) && image.type === MediaType.image && !isMoreLikeThisRefused(image)
  );
}

/** The images feed answers "more like this" under `feedSearch`; otherwise the image search page. */
export const moreLikeThisHref = (features: Pick<FeatureAccess, 'feedSearch'>, imageId: number) =>
  features.feedSearch ? `/images?similarTo=${imageId}` : `/search/images?similarTo=${imageId}`;

export const wantsNewTab = (event: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  button: number;
}) => event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1;

/** Opens the images that look like this one. */
export function MoreLikeThisButton({ image }: { image: MoreLikeThisImage }) {
  const features = useFeatureFlags();
  if (!isMoreLikeThisVisible(features, image)) return null;

  const href = moreLikeThisHref(features, image.id);
  // The card itself is a link to the image detail, so this can't be an anchor inside it: the
  // button opens a tab itself for the clicks that ask for one.
  const open = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (wantsNewTab(event)) window.open(href, '_blank', 'noopener');
    else void Router.push(href);
  };

  return (
    <HoverActionButton
      label="More like this"
      size={30}
      color="white"
      variant="filled"
      data-activity="search:more-like-this"
      onClick={open}
      onAuxClick={(event) => event.button === 1 && open(event)}
    >
      <IconPhotoSearch stroke={2.5} size={16} />
    </HoverActionButton>
  );
}
