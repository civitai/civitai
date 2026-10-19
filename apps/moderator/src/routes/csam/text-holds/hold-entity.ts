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

/** What a moderator can do with a pending hold, in the order the actions are offered. */
export const CSAM_HOLD_DECISIONS = [
  'remove',
  'remove_strike',
  'remove_ban',
  'remove_ban_report',
  'dismiss',
] as const;

export type CsamHoldDecision = (typeof CSAM_HOLD_DECISIONS)[number];

/** The action grants a decision needs besides `csam.report.file`: the ones strike and ban carry on every other page. */
export const CSAM_HOLD_DECISION_GRANTS: Partial<
  Record<CsamHoldDecision, 'user.strike' | 'user.ban'>
> = {
  remove_strike: 'user.strike',
  remove_ban: 'user.ban',
  remove_ban_report: 'user.ban',
};

/** What a decided hold shows in the queue. */
export const CSAM_HOLD_OUTCOMES: Record<CsamHoldDecision, string> = {
  remove: 'Content removed',
  remove_strike: 'Content removed, author struck',
  remove_ban: 'Content removed, author banned',
  remove_ban_report: 'Content removed, author banned — file the CSAM report',
  dismiss: 'Dismissed',
};

/** Removal needs an existing removal path; a chat message has none, so only "do nothing" applies to it. */
const REMOVABLE_ENTITY_TYPES: readonly string[] = [
  'Comment',
  'CommentV2',
  'UserProfile',
  'Post',
  'Model',
];
export const canRemoveHeld = (entityType: string) => REMOVABLE_ENTITY_TYPES.includes(entityType);

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
