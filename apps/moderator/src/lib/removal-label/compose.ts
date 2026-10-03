import type { Answers } from './questions';

/**
 * The label the four answers propose, per the design's composer table (pub.removal-label-check).
 * This only ever PROPOSES. Nothing here decides a removal, clears a hold or lowers anything.
 */
export type ProposedLabel =
  | 'minor_sexual'
  | 'minor_sexual_school'
  | 'minor_violence'
  | 'minor_no_mature_context'
  | 'gore'
  | 'no_minor';

const MINOR = new Set(['appears_minor', 'ambiguous_could_be_minor']);
const THREAT_OR_WORSE = new Set(['threat_or_aiming', 'injury_or_blood', 'graphic_gore']);

/** Null when any answer is `cannot_tell`: no proposal, the moderator's pick stands. */
export function composeLabel(a: Answers): ProposedLabel | null {
  if (
    a.minorPresent === 'cannot_tell' ||
    a.sexualLevel === 'cannot_tell' ||
    a.violence === 'cannot_tell' ||
    a.schoolSetting === 'cannot_tell'
  )
    return null;

  if (MINOR.has(a.minorPresent)) {
    if (a.sexualLevel !== 'none')
      return a.schoolSetting === 'school_classroom_or_campus'
        ? 'minor_sexual_school'
        : 'minor_sexual';
    return THREAT_OR_WORSE.has(a.violence) ? 'minor_violence' : 'minor_no_mature_context';
  }
  return a.violence === 'graphic_gore' ? 'gore' : 'no_minor';
}

export const MINOR_BUCKETS = [
  'animatedMinorNsfw',
  'realisticMinorNsfw',
  'schoolNsfw',
  'realisticMinor',
] as const;
export type MinorBucket = (typeof MINOR_BUCKETS)[number];

export type Stratum = 'removed' | 'not_removed';

/**
 * Why a proposal disagrees with what enforcement did. Null means it agrees.
 *
 * Removed items: `no_minor` (model sees no minor), `not_sexual` (minor, but not sexual: the
 * accusation complaint), `not_school` (sexual minor, but not a school setting).
 * Not-removed items: `flags_minor_sexual` / `flags_minor_violence` (enforcement let through
 * something the model would label).
 */
export type Disagreement =
  | 'no_minor'
  | 'not_sexual'
  | 'not_school'
  | 'flags_minor_sexual'
  | 'flags_minor_violence';

export function disagreement(
  item: { stratum: 'removed'; bucket: MinorBucket } | { stratum: 'not_removed' },
  proposal: ProposedLabel
): Disagreement | null {
  if (item.stratum === 'not_removed') {
    if (proposal === 'minor_sexual' || proposal === 'minor_sexual_school')
      return 'flags_minor_sexual';
    if (proposal === 'minor_violence') return 'flags_minor_violence';
    return null;
  }

  if (proposal === 'no_minor' || proposal === 'gore') return 'no_minor';
  // `realisticMinor` is about the minor being realistic, in any context. Style is not one of the
  // four questions, so the only claim a proposal can contradict there is that a minor is present.
  if (item.bucket === 'realisticMinor') return null;
  if (proposal === 'minor_violence' || proposal === 'minor_no_mature_context') return 'not_sexual';
  if (item.bucket === 'schoolNsfw' && proposal === 'minor_sexual') return 'not_school';
  return null;
}
