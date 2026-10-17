import type { Image } from '@prisma/client';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';

type CoverImage = Pick<
  Image,
  | 'url'
  | 'type'
  | 'ingestion'
  | 'scannedAt'
  | 'tosViolation'
  | 'needsReview'
  | 'blockedFor'
  | 'nsfwLevel'
  | 'poi'
  | 'minor'
>;

export function isPublicCoverImage<T extends CoverImage>(
  image: T | null | undefined,
  browsingLevel: number
): image is T & { type: typeof MediaType.image | typeof MediaType.video } {
  return (
    !!image?.url &&
    image.ingestion === ImageIngestionStatus.Scanned &&
    image.scannedAt != null &&
    image.tosViolation === false &&
    image.needsReview == null &&
    image.blockedFor == null &&
    image.poi === false &&
    image.minor === false &&
    image.nsfwLevel > 0 &&
    Flags.hasFlag(browsingLevel, image.nsfwLevel) &&
    (image.type === MediaType.image || image.type === MediaType.video)
  );
}
