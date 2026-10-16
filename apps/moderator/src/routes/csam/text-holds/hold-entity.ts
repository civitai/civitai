import { chatAuditChatUrl, commentV2Url, entityUrl, userLookupUrl, userUrl } from '$lib/entity-url';

export const NOTE_MAX_LENGTH = 500;

/** The entity types the main app records csam holds for. */
export const CSAM_HOLD_ENTITY_TYPES = [
  'Model',
  'Post',
  'ChatMessage',
  'Comment',
  'CommentV2',
  'ResourceReview',
  'User',
  'UserProfile',
] as const;

export type CsamHoldEntityType = (typeof CSAM_HOLD_ENTITY_TYPES)[number];

export const CSAM_HOLD_ENTITY_LABELS: Record<string, string> = {
  Model: 'Model',
  Post: 'Post',
  ChatMessage: 'Chat message',
  Comment: 'Model comment',
  CommentV2: 'Comment',
  ResourceReview: 'Review',
  User: 'Account',
  UserProfile: 'Profile',
};

export const entityLabel = (entityType: string) =>
  CSAM_HOLD_ENTITY_LABELS[entityType] ?? entityType;

type HoldRef = {
  entityType: string;
  entityId: number;
  userId: number | null;
  username: string | null;
  chatId: number | null;
};

/** Where the held text lives. Null for a legacy model `Comment`: its deep link needs the model id,
 *  which the hold does not record. */
export function holdEntityHref(civitaiUrl: string, hold: HoldRef): string | null {
  switch (hold.entityType) {
    case 'CommentV2':
      return commentV2Url(civitaiUrl, hold.entityId);
    case 'ChatMessage':
      return hold.chatId ? chatAuditChatUrl(hold.chatId) : null;
    case 'User':
    case 'UserProfile':
      if (hold.username) return userUrl(civitaiUrl, hold.username);
      return hold.userId ? userLookupUrl(hold.userId) : null;
    default:
      return entityUrl(civitaiUrl, hold.entityType, hold.entityId);
  }
}
