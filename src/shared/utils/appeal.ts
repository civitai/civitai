import { AppealStatus, Model3DStatus } from '~/shared/utils/prisma/enums';

export const APPEAL_ALREADY_PENDING = 'Your appeal of this removal is already under review.';
export const APPEAL_ALREADY_DECIDED =
  'Your appeal of this removal was reviewed and the decision stands.';

// One appeal per block (Justin, 2026-10-02). An approved appeal lifted the block, so a later block
// is a new decision to contest; a rejected one upheld the block that is still in place. The server
// refuses on this before charging the fee, and the page hides the appeal link on the same verdict.
export function getAppealRefusal(latest: { status: AppealStatus } | null | undefined) {
  if (latest?.status === AppealStatus.Pending) return APPEAL_ALREADY_PENDING;
  if (latest?.status === AppealStatus.Rejected) return APPEAL_ALREADY_DECIDED;
  return null;
}

// Legacy rows carry `blockedFor = 'moderated'` with `ingestion = 'Scanned'`, so `ingestion` alone
// would refuse appeals the page offers.
export function isAppealableImage(image: {
  blockedFor?: string | null;
  needsReview?: string | null;
}) {
  return image.blockedFor?.toLowerCase() === 'moderated' && !image.needsReview;
}

export function isAppealableModel3D(model: { status: Model3DStatus }) {
  return model.status === Model3DStatus.Unpublished || model.status === Model3DStatus.Deleted;
}
