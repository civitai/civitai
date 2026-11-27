import { BlockedReason } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * The block reasons that leave an image's media with its owner: a hold the owner clears by adding
 * metadata, not a safety block. An allow-list, so any other reason, including one added later,
 * refuses the owner the media.
 */
export const OWNER_MEDIA_EXEMPT_BLOCKS: readonly string[] = [BlockedReason.AiNotVerified];

/** Whether a block reason is one its owner can act on. Exact match: a combined value is not. */
export function isOwnerExemptBlock(blockedFor?: string | null): blockedFor is string {
  return blockedFor != null && OWNER_MEDIA_EXEMPT_BLOCKS.includes(blockedFor);
}

/** The block reason an image's owner may see: only one they can act on. */
export function ownerVisibleBlockedFor(blockedFor?: string | null): string | null {
  return isOwnerExemptBlock(blockedFor) ? blockedFor : null;
}

type BlockState = { ingestion?: ImageIngestionStatus | string | null; blockedFor?: string | null };

/**
 * Blocked when ingestion is Blocked or a block reason is present. The owner's live signal carries
 * no reason for most blocks, so ingestion alone must suffice.
 */
export function isImageShownBlocked(image: BlockState) {
  return image.ingestion === ImageIngestionStatus.Blocked || !!image.blockedFor;
}

/**
 * The post editor's TOS notice. An owner-actionable hold is not one: the owner clears it in the
 * editor. The reason is named to moderators only.
 */
export function editorBlockNotice(image: BlockState, isModerator: boolean) {
  const isBlocked =
    image.ingestion === ImageIngestionStatus.Blocked && !isOwnerExemptBlock(image.blockedFor);
  return { isBlocked, reason: isBlocked && isModerator ? image.blockedFor ?? null : null };
}
