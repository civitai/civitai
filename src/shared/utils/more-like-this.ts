import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

export type MoreLikeThisAnchor = {
  ingestion?: ImageIngestionStatus | string | null;
  blockedFor?: string | null;
  minor?: boolean | null;
  poi?: boolean | null;
};

/**
 * Images "more like this" can't search from: the ones Remix refuses image-to-image. The card button
 * and the server's anchor check both decide with this, for every viewer and browsing level.
 */
export function isMoreLikeThisRefused(image: MoreLikeThisAnchor) {
  if (image.ingestion === ImageIngestionStatus.Blocked || image.blockedFor) return true;
  if (image.minor || image.poi) return true;
  return image.ingestion != null && image.ingestion !== ImageIngestionStatus.Scanned;
}
