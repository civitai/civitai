import { Prisma } from '@prisma/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { Flags } from '~/shared/utils/flags';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

/** Every field `isPublicCoverImage` reads, plus what the public `coverImage` object returns. */
export const publicCoverImageSelect = Prisma.validator<Prisma.ImageSelect>()({
  id: true,
  url: true,
  type: true,
  width: true,
  height: true,
  nsfwLevel: true,
  ingestion: true,
  scannedAt: true,
  tosViolation: true,
  needsReview: true,
  blockedFor: true,
  poi: true,
  minor: true,
  acceptableMinor: true,
  postId: true,
});

export type PublicCoverImage = Prisma.ImageGetPayload<{ select: typeof publicCoverImageSelect }>;

/**
 * Whether a collection cover may be shown on the public API at `browsingLevel`. Each check must
 * positively pass, so a field the query did not select hides the cover rather than showing it.
 */
export function isPublicCoverImage(
  image: PublicCoverImage | null | undefined,
  browsingLevel: number
): image is PublicCoverImage {
  return (
    !!image?.url &&
    image.ingestion === ImageIngestionStatus.Scanned &&
    image.scannedAt != null &&
    image.tosViolation === false &&
    image.needsReview === null &&
    image.blockedFor === null &&
    image.poi === false &&
    image.minor === false &&
    image.acceptableMinor === false &&
    image.nsfwLevel > 0 &&
    Flags.hasFlag(browsingLevel, image.nsfwLevel) &&
    (image.type === MediaType.image || image.type === MediaType.video)
  );
}

/** The public `coverImage` object, `null` when the cover may not be shown at `browsingLevel`. */
export function toPublicCoverImage(
  image: PublicCoverImage | null | undefined,
  browsingLevel: number
) {
  if (!isPublicCoverImage(image, browsingLevel)) return null;
  return {
    id: image.id,
    url: getEdgeUrl(image.url, { width: 450, type: image.type }),
    type: image.type,
    width: image.width ?? null,
    height: image.height ?? null,
    nsfwLevel: image.nsfwLevel,
  };
}

/**
 * For each cover, the browsing level it is judged at: `browsingLevel`, narrowed to the held gallery
 * level of its post's minor or SFW-only model.
 */
export async function getCoverBrowsingLevels(
  covers: (Pick<PublicCoverImage, 'postId'> | null | undefined)[],
  browsingLevel: number
) {
  // Loaded on demand: the model service's import graph is large.
  const { getHeldLevelsByPost } = await import('~/server/services/model.service');
  const held = await getHeldLevelsByPost(covers.map((cover) => cover?.postId).filter(isDefined));
  return (cover: Pick<PublicCoverImage, 'postId'> | null | undefined) => {
    const hold = cover?.postId ? held.get(cover.postId) : undefined;
    return hold ? Flags.intersection(browsingLevel, hold.level) : browsingLevel;
  };
}
