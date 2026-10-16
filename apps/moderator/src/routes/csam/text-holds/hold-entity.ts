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

export const CSAM_HOLD_ENTITY_LABELS: Record<CsamHoldEntityType, string> = {
  Model: 'Model',
  Post: 'Post',
  ChatMessage: 'Chat message',
  Comment: 'Model comment',
  CommentV2: 'Comment',
  ResourceReview: 'Review',
  User: 'Account',
  UserProfile: 'Profile',
};

const isCsamHoldEntityType = (value: string): value is CsamHoldEntityType =>
  (CSAM_HOLD_ENTITY_TYPES as readonly string[]).includes(value);

// The column is free text, so a type the main app adds later still renders by its raw name.
export const entityLabel = (entityType: string) =>
  isCsamHoldEntityType(entityType) ? CSAM_HOLD_ENTITY_LABELS[entityType] : entityType;

const PREVIEW_LENGTH = 90;

/** One line of the held text, so holds by one author are told apart in the list. */
export function holdPreview(text: string): string {
  // By code point, so the cut never splits a surrogate pair.
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > PREVIEW_LENGTH
    ? `${chars.slice(0, PREVIEW_LENGTH).join('').trimEnd()}…`
    : chars.join('');
}

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
