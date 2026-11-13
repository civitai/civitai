import { allBrowsingLevelsFlag, getHighestBrowsingLevelBit, NsfwLevel } from '@civitai/shared';
import { overrideBasisDropped } from '@civitai/shared/rated-entity-sql';
import { dbRead } from '~/server/db/client';
import { computeArticleDerivedNsfwLevel } from '~/server/services/article-rating-review.helpers';
import type {
  RatingReviewScan,
  RatingReviewSubject,
} from '~/server/services/rating-review.entities';
import { computeRatedEntityDerivedNsfwLevel } from '~/server/services/text-scan/derived-level';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

export type OverrideEntityType =
  | 'Post'
  | 'Bounty'
  | 'BountyEntry'
  | 'Challenge'
  | 'Crucible'
  | 'Collection';
const OVERRIDE_ENTITY_TYPES = new Set<string>([
  'Post',
  'Bounty',
  'BountyEntry',
  'Challenge',
  'Crucible',
  'Collection',
]);
export const isOverrideEntityType = (t: string): t is OverrideEntityType =>
  OVERRIDE_ENTITY_TYPES.has(t);

// A dispute on one of these is never auto-approved: a moderator always resolves it, in the spoke.
export type ModeratorOnlyEntityType = 'Challenge' | 'Crucible' | 'Collection';
const MODERATOR_ONLY = new Set<string>(['Challenge', 'Crucible', 'Collection']);
export const isModeratorOnlyEntityType = (t: string): t is ModeratorOnlyEntityType =>
  MODERATOR_ONLY.has(t);

const UNSETTLED_IMAGE = [
  ImageIngestionStatus.Pending,
  ImageIngestionStatus.Rescan,
  ImageIngestionStatus.PendingManualAssignment,
  ImageIngestionStatus.Blocked,
  ImageIngestionStatus.Error,
  ImageIngestionStatus.NotFound,
];

export function computeDerivedNsfwLevel(
  entityType: OverrideEntityType | 'Article',
  entityId: number
): Promise<number | null> {
  return entityType === 'Article'
    ? computeArticleDerivedNsfwLevel(entityId)
    : computeRatedEntityDerivedNsfwLevel(entityType, entityId);
}

export type StaleOverrideSignal = {
  derivedLevel: number | null;
  derivedRatingDroppedBelowOverride: boolean;
};

export async function getStaleOverrideSignal(
  entityType: OverrideEntityType | 'Article',
  entityId: number,
  subject: Pick<RatingReviewSubject, 'override' | 'overrideBasis'>
): Promise<StaleOverrideSignal> {
  // Nothing auto-approves these, and a challenge's basis is its allowed mask, which the resolve that
  // wrote the override itself narrows, so a lowered challenge would always read as dropped.
  if (subject.override == null || isModeratorOnlyEntityType(entityType))
    return { derivedLevel: null, derivedRatingDroppedBelowOverride: false };
  const derivedLevel = await computeDerivedNsfwLevel(entityType, entityId);
  return {
    derivedLevel,
    derivedRatingDroppedBelowOverride: overrideBasisDropped({
      moderatorNsfwLevel: subject.override,
      moderatorNsfwLevelBasis: subject.overrideBasis,
      derivedLevel,
    }),
  };
}

export type OverrideGateResult =
  | { eligible: true; derivedLevel: number }
  | { eligible: false; reason: string; derivedLevel: number | null };

async function hasUnsettledImages(entityType: OverrideEntityType, entityId: number) {
  if (isModeratorOnlyEntityType(entityType)) return false;
  const count =
    entityType === 'Post'
      ? await dbRead.image.count({
          where: { postId: entityId, ingestion: { in: UNSETTLED_IMAGE } },
        })
      : await dbRead.imageConnection.count({
          where: { entityType, entityId, image: { ingestion: { in: UNSETTLED_IMAGE } } },
        });
  return count > 0;
}

export async function evaluateOverrideAutoApprove({
  entityType,
  entityId,
  subject,
  scan,
  suggestedLevel,
}: {
  entityType: OverrideEntityType;
  entityId: number;
  subject: RatingReviewSubject;
  scan: RatingReviewScan | null;
  suggestedLevel: number;
}): Promise<OverrideGateResult> {
  const no = (reason: string, derivedLevel: number | null = null): OverrideGateResult => ({
    eligible: false,
    reason,
    derivedLevel,
  });
  if (subject.override == null) return no('no-override');
  if (subject.override === NsfwLevel.Blocked) return no('override-blocked');
  if (suggestedLevel >= subject.currentLevel) return no('not-down-direction');
  if (isModeratorOnlyEntityType(entityType)) return no('moderator-only');
  if (scan?.pending) return no('text-scan-pending');
  if (await hasUnsettledImages(entityType, entityId)) return no('images-not-clean');

  const derivedLevel = await computeDerivedNsfwLevel(entityType, entityId);
  if (!derivedLevel) return no('no-derivable-signal', derivedLevel);
  if (getHighestBrowsingLevelBit(derivedLevel & allBrowsingLevelsFlag) > suggestedLevel)
    return no('derived-exceeds-suggested', derivedLevel);
  if (subject.overrideBasis == null) return no('no-override-basis', derivedLevel);
  if (
    !overrideBasisDropped({
      moderatorNsfwLevel: subject.override,
      moderatorNsfwLevelBasis: subject.overrideBasis,
      derivedLevel,
    })
  )
    return no('content-not-dropped-since-override', derivedLevel);
  return { eligible: true, derivedLevel };
}
