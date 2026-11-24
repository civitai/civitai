import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

export type MoreLikeThisAnchor = {
  ingestion?: ImageIngestionStatus | string | null;
  blockedFor?: string | null;
  minor?: boolean | null;
  poi?: boolean | null;
};

/**
 * Images "more like this" can't search from, for every viewer and browsing level. Stricter than
 * Remix's `getEngineRefusal`, which routes an unscanned image to its safe tier: here it is refused.
 */
export function isMoreLikeThisRefused(image: MoreLikeThisAnchor) {
  if (image.ingestion === ImageIngestionStatus.Blocked || image.blockedFor) return true;
  if (image.minor || image.poi) return true;
  return image.ingestion != null && image.ingestion !== ImageIngestionStatus.Scanned;
}
