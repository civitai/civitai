import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  computeNsfwEscalation,
  type ChallengeBuzzType,
} from '~/server/games/daily-challenge/challenge-currency';
import { createNotification } from '~/server/services/notification.service';
import { refundMultiAccountTransaction } from '~/server/services/buzz.service';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { ChallengeIngestionStatus, ChallengeSource } from '~/shared/utils/prisma/enums';

// Applies the scan verdict to a challenge: marks it Scanned, and on an NSFW verdict raises the
// rating to R, flips a green USER challenge to yellow (moving it off the safe site via the
// domain-currency gate), refunds its green initial prize, and notifies the creator.
//
// Idempotent: the flip is gated on the STORED buzzType === 'green', so a retried callback (already
// yellow) skips the flip + refund. The refund runs BEFORE the challenge update so a crash between
// them re-reads a still-green row and re-attempts the (idempotent) refund rather than stranding it.
export async function applyChallengeNsfwEscalation({
  entityId,
  isNsfw,
}: {
  entityId: number;
  isNsfw: boolean;
}): Promise<void> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: entityId },
    select: {
      allowedNsfwLevel: true,
      buzzType: true,
      source: true,
      basePrizePool: true,
      createdById: true,
      collectionId: true,
    },
  });
  if (!challenge) return;

  const buzzType: ChallengeBuzzType = challenge.buzzType === 'green' ? 'green' : 'yellow';
  const escalation = computeNsfwEscalation({
    allowedNsfwLevel: challenge.allowedNsfwLevel,
    buzzType,
    source: challenge.source,
    basePrizePool: challenge.basePrizePool,
    isNsfw,
  });

  // Refund first (idempotent) so a crash before the update re-runs the refund instead of stranding
  // the green charge once the row is flipped to yellow.
  if (escalation.refundInitialPrize) {
    // No currency suffix: ledger ids are immutable, so pre-deploy charges are still
    // `-creator` (no `-green`/`-yellow`) — the broad prefix matches both (mirrors
    // `refundUserChallengeFunds`). Safe here because the flip only runs on a STORED
    // green challenge, which never holds a `-creator-yellow` charge to collide with.
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix: `challenge-initial-prize-${entityId}-creator`,
      description: 'Challenge flipped to adult site — initial prize refund',
      details: { challengeId: entityId },
    });
  }

  await dbWrite.challenge.update({
    where: { id: entityId },
    data: {
      ingestion: ChallengeIngestionStatus.Scanned,
      scannedAt: new Date(),
      nsfwLevel: escalation.nsfwLevel,
      allowedNsfwLevel: escalation.allowedNsfwLevel,
      ...(escalation.flip && { buzzType: 'yellow' }),
      ...(escalation.refundInitialPrize && { basePrizePool: 0, prizePool: 0 }),
    },
  });

  // Keep the collection's entry-gating level in step with the raised allowed level.
  if (isNsfw && challenge.collectionId) {
    const collection = await dbRead.collection.findUnique({
      where: { id: challenge.collectionId },
      select: { metadata: true },
    });
    await dbWrite.collection.updateMany({
      where: { id: challenge.collectionId },
      data: {
        metadata: {
          ...(collection?.metadata as CollectionMetadataSchema),
          forcedBrowsingLevel: escalation.allowedNsfwLevel,
        },
      },
    });
  }

  if (!challenge.createdById) return;

  if (escalation.flip) {
    await createNotification({
      userId: challenge.createdById,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `challenge-nsfw-flipped-${entityId}`,
      details: {
        message: escalation.refundInitialPrize
          ? "Your challenge's text was flagged as adult content, so it was moved to the adult site (civitai.red) and its rating raised to R. Your initial prize was refunded."
          : "Your challenge's text was flagged as adult content, so it was moved to the adult site (civitai.red) and its rating raised to R.",
        url: `/challenges/${entityId}`,
      },
    });
  } else if (isNsfw && escalation.nsfwLevel > deriveBase(challenge.allowedNsfwLevel)) {
    await createNotification({
      userId: challenge.createdById,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `challenge-nsfw-raised-${entityId}`,
      details: {
        message:
          "Your challenge's rating was raised to R based on its text, so it won't appear in safe-mode feeds.",
        url: `/challenges/${entityId}`,
      },
    });
  }
}

// Local helper: the display level implied by the ORIGINAL allowed mask, to detect an actual raise.
function deriveBase(allowedNsfwLevel: number): number {
  return computeNsfwEscalation({
    allowedNsfwLevel,
    buzzType: 'yellow',
    source: ChallengeSource.User,
    basePrizePool: 0,
    isNsfw: false,
  }).nsfwLevel;
}
