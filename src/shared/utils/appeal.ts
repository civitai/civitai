import { BlockedReason } from '~/server/common/enums';
import { AppealStatus, EntityType, Model3DStatus } from '~/shared/utils/prisma/enums';

export const APPEAL_ALREADY_PENDING = 'Your appeal of this removal is already under review.';
export const APPEAL_ALREADY_DECIDED =
  'Your appeal of this removal was reviewed and the decision stands.';
export const IMAGE_NOT_APPEALABLE = 'Only an image blocked by moderators can be appealed';

// One appeal per block (product decision, 2026-10-02). An approved image appeal lifted the block, so a later
// block is a new decision to contest; a rejected one upheld the block that is still in place. An
// approved 3D model appeal restores nothing, so the model is still under the same removal and any
// decided appeal is final. The server refuses on this before charging the fee, and the page hides
// the appeal link on the same verdict.
export function getAppealRefusal(
  entityType: EntityType,
  latest: { status: AppealStatus } | null | undefined
) {
  if (latest?.status === AppealStatus.Pending) return APPEAL_ALREADY_PENDING;
  if (latest?.status === AppealStatus.Rejected) return APPEAL_ALREADY_DECIDED;
  if (latest?.status === AppealStatus.Approved && entityType === EntityType.Model3D)
    return APPEAL_ALREADY_DECIDED;
  return null;
}

// Legacy rows carry `blockedFor = 'moderated'` with `ingestion = 'Scanned'`, so `ingestion` alone
// would refuse appeals the page offers.
export function isAppealableImage(image: {
  blockedFor?: string | null;
  needsReview?: string | null;
}) {
  return image.blockedFor?.toLowerCase() === BlockedReason.Moderated && !image.needsReview;
}

export function isAppealableModel3D(model: { status: Model3DStatus }) {
  return model.status === Model3DStatus.Unpublished || model.status === Model3DStatus.Deleted;
}

/**
 * Only a title-scan takedown is appealable: a moderator's is not a scan error, and while one holds
 * a grant would lift only the scan's, leaving the storyline down.
 */
export function getStorylineAppealRefusal(storyline: {
  tosViolationByScan: boolean;
  tosViolationByModerator: boolean;
}) {
  if (storyline.tosViolationByModerator)
    return 'A moderator took this storyline down, so it cannot be appealed here';
  if (!storyline.tosViolationByScan) return 'This storyline was not taken down by its title scan';
  return null;
}

/**
 * Recorded on an appeal approved because a moderator lifted the title-scan takedown directly, so
 * the audit trail and overturn counts can tell it from an appeal that was reviewed.
 */
export const DIRECT_LIFT_APPEAL_REASON = 'lifted-by-moderator';
export const DIRECT_LIFT_APPEAL_NOTE =
  'Approved by a moderator lifting the title-scan takedown directly, not an appeal review.';
/** The same, for a takedown a clean rescan of the title lifted. */
export const RESCAN_LIFT_APPEAL_REASON = 'lifted-by-rescan';
export const RESCAN_LIFT_APPEAL_NOTE =
  'Approved because a clean rescan of the title lifted the takedown, not an appeal review.';

// apps/moderator also sends closed-owner-deleted and reviewed-*; it mirrors these strings.
export type OrphanedAppealOutcome =
  | 'under-review'
  | 'closed-owner-deleted'
  | 'closed-unreviewed'
  | 'reviewed-approved'
  | 'reviewed-rejected';

export const OrphanedAppealReason = {
  DeletedByOwner: 'deleted-by-owner',
  RemovedBeforeReview: 'removed-before-review',
} as const;
