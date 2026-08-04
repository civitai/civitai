import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';
import type { ModelMeta } from '~/server/schema/model.schema';

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
  return !!isOwner && !!minor && !!meta?.minorFlagSnapshot;
}

// Written by the minor-hash service and never safe to expose: the snapshot carries
// prevMinorImageIds, and the dismissal/clear stamps describe moderator decisions.
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
    ...rest
  } = meta;

  return rest;
}

export function filterModelMetaForClient(meta: ModelMeta, isModerator?: boolean): ModelMeta {
  return stripMinorHashMeta(filterSensitiveProfanityData(meta, isModerator));
}
