import { OWNER_MEDIA_EXEMPT_BLOCKS } from '~/server/common/image-block-marker';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

type BlockState = { ingestion?: ImageIngestionStatus | string | null; blockedFor?: string | null };

/**
 * Blocked when ingestion is Blocked or a block reason is present. The owner's live signal carries
 * no reason for most blocks, so ingestion alone must suffice.
 */
export function isImageShownBlocked(image: BlockState) {
  return image.ingestion === ImageIngestionStatus.Blocked || !!image.blockedFor;
}

/**
 * The post editor's TOS notice. An owner-actionable hold (`OWNER_MEDIA_EXEMPT_BLOCKS`) is not one:
 * the owner clears it in the editor. The reason is named to moderators only.
 */
export function editorBlockNotice(image: BlockState, isModerator: boolean) {
  const exempt = image.blockedFor != null && OWNER_MEDIA_EXEMPT_BLOCKS.includes(image.blockedFor);
  const isBlocked = image.ingestion === ImageIngestionStatus.Blocked && !exempt;
  return { isBlocked, reason: isBlocked && isModerator ? image.blockedFor ?? null : null };
}
