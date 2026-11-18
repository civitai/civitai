import {
  ChallengeIngestionStatus,
  ChallengeSource,
  ChallengeStatus,
  type ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import {
  isChallengeHiddenByDomainCurrency,
  type ChallengeBuzzType,
} from '~/server/games/daily-challenge/challenge-currency';
import {
  isChallengeHiddenByCoverScan,
  isChallengeHiddenByPoiCover,
} from '~/server/games/daily-challenge/challenge-visibility';

/** Whether `getChallengeDetail` returns null for this viewer, given the rows it looked up. */
export function isChallengeDetailHidden(
  challenge: {
    source: ChallengeSource;
    createdById: number | null;
    visibleAt: Date;
    status: ChallengeStatus;
    ingestion: ChallengeIngestionStatus;
    buzzType: ChallengeBuzzType;
    coverImageId: number | null;
  },
  viewer: {
    id?: number;
    isModerator?: boolean;
    isGreen?: boolean;
    canAccessUserChallenges: boolean;
    blockedByCreator: boolean;
  },
  cover: { poi: boolean; ingestion: ImageIngestionStatus; nsfwLevel: number } | null,
  now: Date
): boolean {
  // Gated here, not only in the UI: direct links, the SSG prefetch and client fetches all come
  // through getChallengeDetail. NSFW-on-green is gated client-side by <Gated>, not here.
  const isUserChallenge = challenge.source === ChallengeSource.User;
  if (isUserChallenge && !viewer.canAccessUserChallenges) return true;
  if (isUserChallenge && viewer.id != null && !viewer.isModerator && viewer.blockedByCreator)
    return true;

  const canPreview =
    viewer.isModerator === true || (viewer.id != null && challenge.createdById === viewer.id);
  if (canPreview) return false;

  if (challenge.visibleAt > now) return true;
  if (challenge.status === ChallengeStatus.Cancelled) return true;
  if (isUserChallenge && challenge.ingestion !== ChallengeIngestionStatus.Scanned) return true;
  if (isUserChallenge && challenge.coverImageId) {
    if (isChallengeHiddenByPoiCover({ ...challenge, coverPoi: cover?.poi ?? false }, viewer.id))
      return true;
    if (isChallengeHiddenByCoverScan({ ...challenge, coverImage: cover }, viewer.id)) return true;
  }
  // On green a mismatched challenge is still returned, so the page can show its redirect card.
  return !viewer.isGreen && isChallengeHiddenByDomainCurrency(challenge, false, viewer.id);
}
