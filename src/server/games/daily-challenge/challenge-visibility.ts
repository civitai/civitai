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

// A challenge's cover image must finish moderation scanning before the challenge is publicly
// visible — separate from (and in addition to) the challenge's own text-scan gate. Pure +
// dependency-free so the rule can be unit-tested in isolation (the feed/detail queries apply the
// equivalent filter via a join/lookup on `Image.ingestion`).
export function isChallengeCoverScanned(challenge: {
  coverImage: { ingestion: ImageIngestionStatus } | null | undefined;
}): boolean {
  return challenge.coverImage?.ingestion === ImageIngestionStatus.Scanned;
}
