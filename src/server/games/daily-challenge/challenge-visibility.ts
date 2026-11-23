import { Prisma } from '@prisma/client';
import {
  hasBlockMarker,
  imageNotRestrictedSql,
  imageReviewedSql,
} from '~/server/common/image-visibility';
import {
  hasPublicBrowsingLevel,
  hasSafeBrowsingLevel,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { ChallengeSource, ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// A user challenge whose cover image depicts a real person (`Image.poi`, set by the image scanner)
// is kept out of public view — everywhere except from its own creator, mirroring the scan gate.
// System/mod challenges are trusted and never hidden here. Pure + dependency-free so the rule can
// be unit-tested in isolation (the feed applies the equivalent filter in SQL).
export function isChallengeHiddenByPoiCover(
  challenge: { source: ChallengeSource; createdById: number | null; coverPoi: boolean },
  viewerId?: number
): boolean {
  return (
    challenge.source === ChallengeSource.User &&
    challenge.createdById !== viewerId &&
    challenge.coverPoi
  );
}

// The browsing level the server will actually filter on. On the green (SFW) site the requested
// level is bitwise-AND'd against a hard cap so a hand-crafted request can't raise the ceiling, and
// an absent level falls back to the cap (instead of "no filter") — otherwise a client that simply
// omits `browsingLevel` would bypass NSFW filtering on green entirely. Logged-in green viewers get
// PG + PG-13; anonymous get PG only. Off green the request passes through unchanged (0 = no filter).
// Mirrors the pattern in comics.router.ts. Pure + dependency-free for unit testing.
export function getEffectiveBrowsingLevel({
  isGreen,
  isLoggedIn,
  requested,
}: {
  isGreen: boolean;
  isLoggedIn: boolean;
  requested?: number | null;
}): number {
  if (!isGreen) return requested && requested > 0 ? requested : 0;
  const greenCap = isLoggedIn ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
  if (!requested || requested <= 0) return greenCap;
  // Mask the request to the SFW cap. A request for ONLY NSFW bits (e.g. R|X|XXX) masks to 0 — fall
  // back to the cap rather than returning 0, which callers treat as "no filter" and would leak
  // everything on green. On green the result is therefore always > 0 (a non-empty SFW set).
  const clamped = requested & greenCap;
  return clamped > 0 ? clamped : greenCap;
}

// True when an image at `nsfwLevel` must be withheld from a viewer on the green (SFW) site —
// unknown/unrated (null/0) counts as unsafe. Logged-in green viewers may see PG + PG-13, anonymous
// PG only. The CALLER decides green-ness (`isGreen`) and any creator exemption; this is the pure
// per-image predicate reused by the detail cover gate and the winners-thumbnail strip.
export function isImageHiddenFromGreenViewer(
  nsfwLevel: number | null | undefined,
  viewerId?: number
): boolean {
  const passes = viewerId != null ? hasSafeBrowsingLevel : hasPublicBrowsingLevel;
  return nsfwLevel == null || nsfwLevel === 0 || !passes(nsfwLevel);
}

// A challenge's cover image must finish moderation scanning, and carry a rating, before the
// challenge is publicly visible — separate from (and in addition to) the challenge's own text-scan
// gate. Pure + dependency-free so the rule can be unit-tested in isolation (the feed/detail queries
// apply the equivalent filter via a join/lookup on `Image.ingestion` and `Image.nsfwLevel`).
export function isChallengeCoverScanned(challenge: {
  coverImage: { ingestion: ImageIngestionStatus; nsfwLevel: number } | null | undefined;
}): boolean {
  return (
    challenge.coverImage?.ingestion === ImageIngestionStatus.Scanned &&
    challenge.coverImage.nsfwLevel !== 0
  );
}

// Combines the cover-scan check above with the same source/creator scoping as
// `isChallengeHiddenByPoiCover`: only user challenges are gated on cover-scan status —
// System/mod covers are trusted and default to Scanned, so they're exempt. Creator exempt so
// they can preview their own pending cover. Pure + dependency-free so the rule can be
// unit-tested in isolation (the feed applies the equivalent filter in SQL).
export function isChallengeHiddenByCoverScan(
  challenge: {
    source: ChallengeSource;
    createdById: number | null;
    coverImage: { ingestion: ImageIngestionStatus; nsfwLevel: number } | null | undefined;
  },
  viewerId?: number
): boolean {
  return (
    challenge.source === ChallengeSource.User &&
    challenge.createdById !== viewerId &&
    !isChallengeCoverScanned({ coverImage: challenge.coverImage })
  );
}

// The image state `winnerImageFields` needs, as columns over `"Image" i`. A song under review (held
// for csam by its lyrics or cover) counts as unreviewed, so its image is withheld.
export const winnerImageStateSql = Prisma.sql`
  i.ingestion AS "imageIngestion",
  i."blockedFor" AS "imageBlockedFor",
  (${imageReviewedSql()} AND (i.type <> 'audio' OR i."needsReview" IS NULL)) AS "imageReviewed",
  ${imageNotRestrictedSql()} AS "imageNotRestricted"`;

// A winner's image as any site may serve it: a blocked, unscanned, unrated or model-restricted image
// is withheld everywhere, while the winner and their place stay. All four fields go, because
// WinnerPodiumCard reads an id and hash with no url as "gated on this site" and links to the image
// on the other one.
export function winnerImageFields(row: {
  imageId: number | null;
  imageUrl: string | null;
  imageNsfwLevel: number | null;
  imageHash: string | null;
  imageIngestion: ImageIngestionStatus | null;
  imageBlockedFor: string | null;
  imageReviewed: boolean | null;
  imageNotRestricted: boolean | null;
}) {
  const { imageId, imageUrl, imageNsfwLevel, imageHash } = row;
  const withheld =
    imageId != null &&
    (!row.imageReviewed ||
      imageNsfwLevel === 0 ||
      !row.imageNotRestricted ||
      hasBlockMarker({
        ingestion: row.imageIngestion ?? '',
        nsfwLevel: imageNsfwLevel ?? 0,
        blockedFor: row.imageBlockedFor,
      }));
  return withheld
    ? { imageId: null, imageUrl: null, imageNsfwLevel: null, imageHash: null }
    : { imageId, imageUrl, imageNsfwLevel, imageHash };
}
