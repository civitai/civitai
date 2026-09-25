import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import type { TextScanEntityType, TextScanMode } from '~/server/services/text-scan/types';

export const TEXT_SCAN_FLAG: Record<TextScanEntityType, FLIPT_FEATURE_FLAGS> = {
  Model: FLIPT_FEATURE_FLAGS.TEXT_SCAN_MODEL,
  Article: FLIPT_FEATURE_FLAGS.TEXT_SCAN_ARTICLE,
  Post: FLIPT_FEATURE_FLAGS.TEXT_SCAN_POST,
  Bounty: FLIPT_FEATURE_FLAGS.TEXT_SCAN_BOUNTY,
  BountyEntry: FLIPT_FEATURE_FLAGS.TEXT_SCAN_BOUNTY_ENTRY,
  Challenge: FLIPT_FEATURE_FLAGS.TEXT_SCAN_CHALLENGE,
  ChatMessage: FLIPT_FEATURE_FLAGS.TEXT_SCAN_CHAT,
  Comment: FLIPT_FEATURE_FLAGS.TEXT_SCAN_COMMENT,
  CommentV2: FLIPT_FEATURE_FLAGS.TEXT_SCAN_COMMENT_V2,
  ResourceReview: FLIPT_FEATURE_FLAGS.TEXT_SCAN_RESOURCE_REVIEW,
  User: FLIPT_FEATURE_FLAGS.TEXT_SCAN_USER,
  UserProfile: FLIPT_FEATURE_FLAGS.TEXT_SCAN_USER_PROFILE,
};

export async function getTextScanMode(
  entityType: TextScanEntityType,
  entityId: number
): Promise<TextScanMode> {
  try {
    const variant = await getFliptVariant(TEXT_SCAN_FLAG[entityType], String(entityId));
    return variant === 'shadow' || variant === 'active' ? variant : 'off';
  } catch {
    return 'off';
  }
}

export const TEXT_SCAN_SHADOW_SUFFIX = ':shadow';

// Shadow verdicts live on their own EntityModeration row. The live row is read by rating
// floors and owned by the pipeline still acting (XGuard for Model/Article/Challenge);
// sharing it would let a shadow verdict raise ratings and clobber the live workflowId.
export function textScanEmEntityType(entityType: TextScanEntityType, mode: 'shadow' | 'active') {
  return mode === 'shadow' ? `${entityType}${TEXT_SCAN_SHADOW_SUFFIX}` : entityType;
}

export function parseTextScanEmEntityType(emEntityType: string) {
  const shadow = emEntityType.endsWith(TEXT_SCAN_SHADOW_SUFFIX);
  return {
    entityType: shadow ? emEntityType.slice(0, -TEXT_SCAN_SHADOW_SUFFIX.length) : emEntityType,
    shadow,
  };
}
