import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';
import type { ModelMeta } from '~/server/schema/model.schema';
import { hasOpenTextScanFlag } from '~/server/services/text-scan/flag-snapshot';
import { REMOVED_WITH_OWNER_META_KEYS } from '~/server/utils/legal-hold';

export function isMinorAutoFlagged(meta: ModelMeta | null | undefined): boolean {
  const snapshot = meta?.minorFlagSnapshot;
  if (!snapshot) return false;
  return (snapshot.confirmedFrom ?? snapshot.source) === 'auto';
}

// The ~13.7k pre-feature flags carry no minorFlagSnapshot; they stay on the
// support-contact path instead of the appeal flow until backfilled.
export function resolveMinorFlagged({
  isOwner,
  minor,
  meta,
}: {
  isOwner: boolean | null | undefined;
  minor: boolean | null | undefined;
  meta: ModelMeta | null | undefined;
}): boolean {
  return !!isOwner && !!minor && (!!meta?.minorFlagSnapshot || hasOpenTextScanFlag(meta, 'minor'));
}

export function resolvePoiFlagged({
  isOwner,
  poi,
  meta,
}: {
  isOwner: boolean | null | undefined;
  poi: boolean | null | undefined;
  meta: ModelMeta | null | undefined;
}): boolean {
  return !!isOwner && !!poi && (!!meta?.poiFlagSnapshot || hasOpenTextScanFlag(meta, 'poi'));
}

// The enforced privacy boundary for the appeal: whatever the caller passes in
// as `appeal`, a non-owner gets null. Keeps that guarantee testable on its own,
// independent of whether the caller also bothers to skip the fetch for visitors.
export function resolveMinorAppeal<T>({
  isOwner,
  appeal,
}: {
  isOwner: boolean | null | undefined;
  appeal: T | null;
}): T | null {
  return isOwner ? appeal : null;
}

// Written by the minor-hash service and never safe to expose: the snapshot carries
// prevMinorImageIds, the dismissal/clear stamps describe moderator decisions, and
// textModeration forensics and the systemNsfwLock source are for moderator review only.
// The single definition of which meta keys are secret — everything that hands a
// Model.meta back to a client must go through this.
export function stripMinorHashMeta(meta: ModelMeta): ModelMeta;
export function stripMinorHashMeta(meta: ModelMeta | null): ModelMeta | null;
export function stripMinorHashMeta(meta: ModelMeta | null): ModelMeta | null {
  if (!meta) return meta;

  const {
    minorFlagSnapshot: _snapshot,
    ownerFlagOverride: _ownerFlagOverride,
    minorHashDismissed: _dismissed,
    minorHashCleared: _cleared,
    minorHashAccepted: _accepted,
    poiFlagSnapshot: _poiSnapshot,
    poiHashMatch: _poiMatch,
    poiHashCleared: _poiCleared,
    textModeration: _textModeration,
    textScanFlags: _textScanFlags,
    modelRules: _modelRules,
    modelRulesCleared: _modelRulesCleared,
    systemNsfwLock: _systemNsfwLock,
    ...rest
  } = meta;

  return rest;
}

/**
 * Meta keys only a server-side moderation path may write. `modelUpsertSchema.meta`
 * is a `looseObject`, so unknown keys survive parsing and are merged into
 * `Model.meta` with the client's copy winning — without this, a creator can author
 * their own `textModeration` forensics for a moderator to read, or mint the
 * `minorFlagSnapshot` that the appeal flow treats as proof of an automated flag.
 *
 * Deliberately the same list as `stripMinorHashMeta` plus the profanity pair: a key
 * that is never safe to hand out is never safe to accept either, and keeping one
 * list means the two directions cannot drift apart.
 */
const MODERATION_OWNED_META_KEYS = [
  'minorFlagSnapshot',
  'ownerFlagOverride',
  'minorHashDismissed',
  'minorHashCleared',
  'minorHashAccepted',
  'poiFlagSnapshot',
  'poiHashMatch',
  'poiHashCleared',
  'textModeration',
  'textScanFlags',
  'modelRules',
  'modelRulesCleared',
  'profanityMatches',
  'profanityEvaluation',
] as const satisfies readonly (keyof ModelMeta)[];

/**
 * Meta keys written only by moderation and system flows (takedown, unpublish, decline, archive,
 * promotion/publish bans). Unlike `MODERATION_OWNED_META_KEYS` they are shown to the owner, so
 * `stripMinorHashMeta` does not hide them; an owner still must not author or clear them through
 * `model.upsert`, where a form that echoes `meta` back would otherwise overwrite the stored value.
 */
export const MODERATION_FLOW_META_KEYS = [
  'cannotPublish',
  'cannotPromote',
  'unpublishedReason',
  'unpublishedAt',
  'unpublishedBy',
  'customMessage',
  'needsReview',
  'declinedReason',
  'declinedAt',
  'takenDownAt',
  'takenDownBy',
  'archivedAt',
  'archivedBy',
] as const satisfies readonly (keyof ModelMeta)[];

/**
 * Drops moderation-owned keys from CLIENT-supplied meta on the way in. Moderators
 * pass through untouched — they reach the same field through moderator-only routers
 * and stripping there would break those flows.
 *
 * Must run before any server-side path adds its own keys to the same object, or it
 * strips the values that path just wrote.
 */
export function stripModerationOwnedMeta<T extends ModelMeta | null | undefined>(
  meta: T,
  isModerator?: boolean
): T {
  if (!meta || isModerator) return meta;

  const rest = { ...meta } as ModelMeta;
  for (const key of MODERATION_OWNED_META_KEYS) delete rest[key];
  for (const key of MODERATION_FLOW_META_KEYS) delete rest[key];

  return rest as T;
}

/**
 * Server-only marker, outside `ModelMeta`: set by `privateModelFromTraining` when a moderator's
 * `cannotPromote` was in force before the private cycle forced it on, and consumed by
 * `publishPrivateModel` to put that value back.
 */
export const RESTORE_CANNOT_PROMOTE_KEY = 'restoreCannotPromote';

/**
 * Meta of a model that is Private after a moderator's `cannotPromote` decision: the flag stays forced
 * on while private, and the decision is kept in the restore marker for `publishPrivateModel`.
 * `banned: true` records it; `false` drops the marker so publish makes the model promotable.
 */
export function withPrivateCannotPromote<T extends object>(meta: T, banned: boolean): T {
  const { [RESTORE_CANNOT_PROMOTE_KEY]: _marker, ...rest } = meta as Record<string, unknown>;
  return {
    ...rest,
    cannotPromote: true,
    ...(banned && { [RESTORE_CANNOT_PROMOTE_KEY]: true }),
  } as T;
}

/**
 * Meta keys only server code may write, for everyone including moderators: no moderator flow writes
 * them through client meta. `trainingStudioWorkflowId` links a model to its training workflow and
 * `trainingStudioModerationApproved` records that the run passed the moderation check; the publish
 * paths read both. `systemNsfwLock` marks an nsfw lock a system check added, which the owner may
 * dispute. Client meta that carries them is ignored, so on update the stored values survive the
 * `{ ...prevMeta, ...meta }` merge.
 */
export const SERVER_OWNED_META_KEYS = [
  'trainingStudioWorkflowId',
  'trainingStudioModerationApproved',
  'systemNsfwLock',
] as const satisfies readonly (keyof ModelMeta)[];

export function systemNsfwLockMarker(source: string): ModelMeta['systemNsfwLock'] {
  return { source, at: new Date().toISOString() };
}

/** When a system check added the nsfw lock, or null when the stored marker is missing or malformed. */
export function readSystemNsfwLockAt(meta: unknown): Date | null {
  const marker = (meta as ModelMeta | null)?.systemNsfwLock;
  if (!marker || typeof marker.at !== 'string') return null;
  const at = new Date(marker.at);
  return Number.isNaN(at.getTime()) ? null : at;
}

// A content wipe's removal record is written and cleared by server code only: a moderator's edit
// form sends stored meta back, and must not put a stale record onto a live model.
const SERVER_ONLY_META_KEYS: readonly string[] = [
  ...SERVER_OWNED_META_KEYS,
  RESTORE_CANNOT_PROMOTE_KEY,
  ...REMOVED_WITH_OWNER_META_KEYS,
];

export function stripServerOwnedMeta<T extends ModelMeta | null | undefined>(meta: T): T {
  if (!meta) return meta;
  const rest = { ...meta } as Record<string, unknown>;
  for (const key of SERVER_ONLY_META_KEYS) delete rest[key];
  return rest as T;
}

function pickKeys(meta: ModelMeta | null | undefined, keys: readonly string[]): ModelMeta {
  const picked: Record<string, unknown> = {};
  if (!meta) return picked as ModelMeta;
  const source = meta as Record<string, unknown>;
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return picked as ModelMeta;
}

/** The server-owned keys of a stored meta, to carry across a write that replaces meta wholesale. */
export function pickServerOwnedMeta(meta: ModelMeta | null | undefined): ModelMeta {
  return pickKeys(meta, SERVER_ONLY_META_KEYS);
}

const PUBLISH_KEPT_META_KEYS: readonly string[] = [
  ...SERVER_ONLY_META_KEYS,
  ...MODERATION_OWNED_META_KEYS,
  'cannotPublish',
  'cannotPromote',
];

/** `meta` with the keys no publish may set or clear taken from `stored`, the row it overwrites. */
export function withStoredPublishKeys(meta: ModelMeta, stored: ModelMeta | null): ModelMeta {
  const rest = { ...meta } as Record<string, unknown>;
  for (const key of PUBLISH_KEPT_META_KEYS) delete rest[key];
  return { ...rest, ...pickKeys(stored, PUBLISH_KEPT_META_KEYS) } as ModelMeta;
}

/** The moderation-owned and moderation-flow keys of a stored meta, for a wholesale meta write by a non-moderator. */
export function pickModerationOwnedMeta(
  meta: ModelMeta | null | undefined,
  { includeFlowKeys = true }: { includeFlowKeys?: boolean } = {}
): ModelMeta {
  return pickKeys(meta, [
    ...MODERATION_OWNED_META_KEYS,
    ...(includeFlowKeys ? MODERATION_FLOW_META_KEYS : []),
  ]);
}

export function filterModelMetaForClient(meta: ModelMeta, isModerator?: boolean): ModelMeta {
  return stripMinorHashMeta(filterSensitiveProfanityData(meta, isModerator));
}
