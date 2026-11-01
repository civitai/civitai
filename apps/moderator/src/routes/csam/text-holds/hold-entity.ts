import { shortAge } from '$lib/format';
import {
  chatAuditChatUrl,
  commentV2Url,
  entityUrl,
  modelCommentUrl,
  userLookupUrl,
  userUrl,
} from '$lib/entity-url';

export const NOTE_MAX_LENGTH = 500;

/** The entity types whose text-scan profile requests the csam label, so the only ones a hold can exist for. */
export const CSAM_HOLD_ENTITY_TYPES = [
  'Model',
  'Post',
  'Article',
  'ChatMessage',
  'Comment',
  'CommentV2',
  'UserProfile',
] as const;

export type CsamHoldEntityType = (typeof CSAM_HOLD_ENTITY_TYPES)[number];

export const CSAM_HOLD_ENTITY_LABELS: Record<CsamHoldEntityType, string> = {
  Model: 'Model',
  Post: 'Post',
  Article: 'Article',
  ChatMessage: 'Chat message',
  Comment: 'Model comment',
  CommentV2: 'Comment',
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

/** A duplicate pending hold the one-hold-per-entity migration closed; nobody ruled on it. */
export const SUPERSEDED_OUTCOME = 'Superseded by a newer scan';

export function decisionLabel(hold: { status: string; decision: string | null }): string {
  if (hold.decision === 'superseded') return SUPERSEDED_OUTCOME;
  const outcome =
    hold.decision && hold.decision in CSAM_HOLD_OUTCOMES
      ? CSAM_HOLD_OUTCOMES[hold.decision as CsamHoldDecision]
      : null;
  return outcome ?? (hold.status === 'Dismissed' ? 'Dismissed' : 'Removed');
}

/** The types the main app can remove without destroying them; a type outside the list only gets "do nothing". */
const REMOVABLE_ENTITY_TYPES: readonly string[] = [
  'ChatMessage',
  'Comment',
  'CommentV2',
  'UserProfile',
  'Post',
  'Model',
  'Article',
];
export const canRemoveHeld = (entityType: string) => REMOVABLE_ENTITY_TYPES.includes(entityType);

const isCsamHoldEntityType = (value: string): value is CsamHoldEntityType =>
  (CSAM_HOLD_ENTITY_TYPES as readonly string[]).includes(value);

// The column is free text, so a type the main app adds later still renders by its raw name.
export const entityLabel = (entityType: string) =>
  isCsamHoldEntityType(entityType) ? CSAM_HOLD_ENTITY_LABELS[entityType] : entityType;

/** The decision keys in key order: digit `n + 1` picks index `n`. */
export const CSAM_HOLD_KEY_ORDER = [
  'dismiss',
  'remove',
  'remove_strike',
  'remove_ban',
  'remove_ban_report',
] as const satisfies readonly CsamHoldDecision[];

export function holdDecisionEnabled(
  hold: { entityType: string; status: string; userId: number | null },
  grants: { canDecide: boolean; canStrike: boolean; canBan: boolean }
): boolean[] {
  if (!grants.canDecide || hold.status !== 'Pending') return [];
  const removable = canRemoveHeld(hold.entityType);
  const hasAuthor = hold.userId !== null;
  const gate = (needsGrant: boolean) => removable && hasAuthor && needsGrant;
  return CSAM_HOLD_KEY_ORDER.map((decision) => {
    switch (decision) {
      case 'dismiss':
        return true;
      case 'remove':
        return removable;
      case 'remove_strike':
        return gate(grants.canStrike);
      case 'remove_ban':
      case 'remove_ban_report':
        return gate(grants.canBan);
    }
  });
}

export const CSAM_HOLD_CONFIRMS: Partial<
  Record<CsamHoldDecision, { label: string; title: string; description: string }>
> = {
  remove_strike: {
    label: 'Remove content + strike',
    title: 'Remove the content and strike the author?',
    description: 'The content is taken down and the author receives a strike and a notification.',
  },
  remove_ban: {
    label: 'Remove content + ban',
    title: 'Remove the content and ban the author?',
    description:
      'The content is taken down and the account is banned, which also removes its other content.',
  },
  remove_ban_report: {
    label: 'Remove content + ban + NCMEC report',
    title: 'Remove, ban and file an NCMEC report?',
    description:
      'The content is taken down and the account is banned. The CSAM report form then opens for the author so you can file the report.',
  },
};

export function holdTitle(hold: {
  entityType: string;
  entityId: number;
  title: string | null;
  username: string | null;
  userId: number | null;
}): string {
  switch (hold.entityType) {
    case 'ChatMessage':
      return 'Chat';
    case 'Comment':
    case 'CommentV2':
      return 'Comment';
    case 'UserProfile':
      return hold.username ?? (hold.userId ? `user #${hold.userId}` : 'Profile');
    default:
      return hold.title?.trim() || `${entityLabel(hold.entityType)} #${hold.entityId}`;
  }
}

/** A pending row shows the newest event: when its text was last replaced, else when it was held. */
export function holdMeta(
  hold: {
    status: string;
    createdAt: Date;
    decidedAt: Date | null;
    textUpdatedAt?: Date | string | null;
  },
  now = Date.now()
): string {
  if (hold.status === 'Pending' || !hold.decidedAt)
    return hold.textUpdatedAt
      ? `text updated ${shortAge(hold.textUpdatedAt, now)}`
      : `held ${shortAge(hold.createdAt, now)}`;
  return `decided ${shortAge(hold.decidedAt, now)}`;
}

export function splitEmptyTypes<T extends string>(
  types: readonly T[],
  counts: Record<string, number> | null,
  selected: string | null
): { shown: T[]; empty: T[] } {
  if (!counts) return { shown: [...types], empty: [] };
  const shown = types.filter((t) => (counts[t] ?? 0) > 0 || t === selected);
  return { shown, empty: types.filter((t) => !shown.includes(t)) };
}

type HoldRef = {
  entityType: string;
  entityId: number;
  userId: number | null;
  username: string | null;
  chatId: number | null;
  commentModelId?: number | null;
};

/** Where the held text lives. Null for a legacy model `Comment` whose model could not be read. */
export function holdEntityHref(civitaiUrl: string, hold: HoldRef): string | null {
  switch (hold.entityType) {
    case 'CommentV2':
      return commentV2Url(civitaiUrl, hold.entityId);
    case 'Comment':
      return hold.commentModelId
        ? modelCommentUrl(civitaiUrl, hold.commentModelId, hold.entityId)
        : null;
    case 'ChatMessage':
      return hold.chatId ? chatAuditChatUrl(hold.chatId) : null;
    case 'UserProfile':
      if (hold.username) return userUrl(civitaiUrl, hold.username);
      return hold.userId ? userLookupUrl(hold.userId) : null;
    default:
      return entityUrl(civitaiUrl, hold.entityType, hold.entityId);
  }
}
