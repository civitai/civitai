import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Whether a card shows an image as blocked. `ingestion` decides it on its own: the owner's live
 * signal carries no block reason for most blocks.
 */
export function isImageShownBlocked(image: {
  ingestion?: ImageIngestionStatus | string;
  blockedFor?: string | null;
}) {
  return image.ingestion === ImageIngestionStatus.Blocked || !!image.blockedFor;
}
