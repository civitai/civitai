import { Flags } from '~/shared/utils/flags';

type Cover = { nsfwLevel: number };
type CollectionHitCovers<I extends Cover> = {
  image?: I | null;
  images: I[];
  srcs: string[];
};

/**
 * A collection search hit's covers at or below the viewer's browsing level. The index rates the
 * collection by its items, so a hit can carry covers above that level. `srcs` carry no rating, so
 * they go too once any image is dropped.
 */
export function coversWithinBrowsingLevel<I extends Cover, H extends CollectionHitCovers<I>>(
  hit: H,
  browsingLevel: number
): H {
  const allowed = (image: Cover) => Flags.intersects(image.nsfwLevel, browsingLevel);
  const images = hit.images.filter(allowed);
  const image = hit.image && allowed(hit.image) ? hit.image : null;
  const dropped = images.length < hit.images.length || (!!hit.image && !image);
  return { ...hit, image, images, srcs: dropped ? [] : hit.srcs };
}
