import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';
import type { ModelMeta } from '~/server/schema/model.schema';

// Written by the minor-hash service and never safe to expose: the snapshot carries
// prevMinorImageIds, and the dismissal/clear stamps describe moderator decisions.
export function isMinorAutoFlagged(meta: ModelMeta | null | undefined): boolean {
  const snapshot = meta?.minorFlagSnapshot;
  if (!snapshot) return false;
  return (snapshot.confirmedFrom ?? snapshot.source) === 'auto';
}

export function filterModelMetaForClient(meta: ModelMeta, isModerator?: boolean): ModelMeta {
  const {
    minorFlagSnapshot: _snapshot,
    minorHashDismissed: _dismissed,
    minorHashCleared: _cleared,
    ...rest
  } = filterSensitiveProfanityData(meta, isModerator);

  return rest;
}
