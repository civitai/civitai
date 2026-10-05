import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import type { TextScanEntityType, TextScanMode } from '~/server/services/text-scan/types';

// Enum KEYS, not values: read at module scope, the enum breaks every suite that hand-lists a
// `~/server/flipt/client` mock without it, and this module is in model.service's import graph.
export const TEXT_SCAN_FLAG_KEY = {
  Model: 'TEXT_SCAN_MODEL',
  Article: 'TEXT_SCAN_ARTICLE',
  Post: 'TEXT_SCAN_POST',
  Bounty: 'TEXT_SCAN_BOUNTY',
  BountyEntry: 'TEXT_SCAN_BOUNTY_ENTRY',
  Challenge: 'TEXT_SCAN_CHALLENGE',
  ChatMessage: 'TEXT_SCAN_CHAT',
  Comment: 'TEXT_SCAN_COMMENT',
  CommentV2: 'TEXT_SCAN_COMMENT_V2',
  ResourceReview: 'TEXT_SCAN_RESOURCE_REVIEW',
  User: 'TEXT_SCAN_USER',
  UserProfile: 'TEXT_SCAN_USER_PROFILE',
  Crucible: 'TEXT_SCAN_CRUCIBLE',
  Collection: 'TEXT_SCAN_COLLECTION',
} as const satisfies Record<TextScanEntityType, keyof typeof FLIPT_FEATURE_FLAGS>;

export function textScanFlag(entityType: TextScanEntityType): FLIPT_FEATURE_FLAGS {
  return FLIPT_FEATURE_FLAGS[TEXT_SCAN_FLAG_KEY[entityType]];
}

export async function getTextScanMode(
  entityType: TextScanEntityType,
  entityId: number
): Promise<TextScanMode> {
  try {
    const variant = await getFliptVariant(textScanFlag(entityType), String(entityId));
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
