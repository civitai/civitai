import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';
import type { ModelMeta } from '~/server/schema/model.schema';
import { hasOpenTextScanFlag } from '~/server/services/text-scan/flag-snapshot';

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
  return !!isOwner && !!poi && hasOpenTextScanFlag(meta, 'poi');
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
// textModeration forensics are for moderator review only.
// The single definition of which meta keys are secret — everything that hands a
// Model.meta back to a client must go through this.
export function stripMinorHashMeta(meta: ModelMeta): ModelMeta;
export function stripMinorHashMeta(meta: ModelMeta | null): ModelMeta | null;
export function stripMinorHashMeta(meta: ModelMeta | null): ModelMeta | null {
  if (!meta) return meta;

  const {
    minorFlagSnapshot: _snapshot,
    minorHashDismissed: _dismissed,
    minorHashCleared: _cleared,
    minorHashAccepted: _accepted,
    textModeration: _textModeration,
    textScanFlags: _textScanFlags,
    modelRules: _modelRules,
    modelRulesCleared: _modelRulesCleared,
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
  'minorHashDismissed',
  'minorHashCleared',
  'minorHashAccepted',
  'textModeration',
  'textScanFlags',
  'modelRules',
  'modelRulesCleared',
  'profanityMatches',
  'profanityEvaluation',
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

  return rest as T;
}

/**
 * Meta keys only server code may write, for everyone including moderators: no moderator flow writes
 * them through client meta. `trainingStudioWorkflowId` links a model to its training workflow and
 * `trainingStudioModerationApproved` records that the run passed the moderation check; the publish
 * paths read both. Client meta that carries them is ignored, so on update the stored values survive
 * the `{ ...prevMeta, ...meta }` merge.
 */
export const SERVER_OWNED_META_KEYS = [
  'trainingStudioWorkflowId',
  'trainingStudioModerationApproved',
] as const satisfies readonly (keyof ModelMeta)[];

export function stripServerOwnedMeta<T extends ModelMeta | null | undefined>(meta: T): T {
  if (!meta) return meta;
  const rest = { ...meta } as ModelMeta;
  for (const key of SERVER_OWNED_META_KEYS) delete rest[key];
  return rest as T;
}

/** The server-owned keys of a stored meta, to carry across a write that replaces meta wholesale. */
export function pickServerOwnedMeta(meta: ModelMeta | null | undefined): ModelMeta {
  const picked: ModelMeta = {};
  if (!meta) return picked;
  for (const key of SERVER_OWNED_META_KEYS)
    if (meta[key] !== undefined) (picked as Record<string, unknown>)[key] = meta[key];
  return picked;
}

export function filterModelMetaForClient(meta: ModelMeta, isModerator?: boolean): ModelMeta {
  return stripMinorHashMeta(filterSensitiveProfanityData(meta, isModerator));
}
