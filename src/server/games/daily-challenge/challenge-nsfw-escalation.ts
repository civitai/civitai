import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  computeNsfwEscalation,
  type ChallengeBuzzType,
} from '~/server/games/daily-challenge/challenge-currency';
import { createNotification } from '~/server/services/notification.service';
import { voidChallenge } from '~/server/services/challenge.service';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import {
  ChallengeIngestionStatus,
  ChallengeSource,
  ChallengeStatus,
} from '~/shared/utils/prisma/enums';
import { logToAxiom } from '~/server/logging/client';

// Applies the scan verdict to a challenge. A green USER challenge whose text is NSFW is cancelled
// (green must be SFW): void it (Cancelled + collection closed + initial prize refunded, all idempotent),
// mark the scan resolved, and notify the creator to recreate on civitai.red. A yellow/non-user challenge
// stays live but has its rating raised to R. A clean scan just marks it Scanned.
//
// Idempotent: the cancel path relies on voidChallenge's own idempotency (a retried callback re-runs the
// no-op refund on the already-Cancelled row) plus a deterministic notification key. buzzType is never
// changed, so the cancel decision is stable across retries.
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
      createdById: true,
      collectionId: true,
      status: true,
    },
  });
  if (!challenge) return;

  const buzzType: ChallengeBuzzType = challenge.buzzType === 'green' ? 'green' : 'yellow';
  const escalation = computeNsfwEscalation({
    allowedNsfwLevel: challenge.allowedNsfwLevel,
    buzzType,
    source: challenge.source,
    isNsfw,
  });

  if (escalation.cancel) {
    // Only auto-void a challenge that has NOT started. A Scheduled green challenge is entry-free
    // (entry gate) — or holds only legacy pre-gate free entries — so voiding it (Cancelled +
    // collection closed + prize refunded, all idempotent) is always safe. Void FIRST so a crash
    // before the scan-state write leaves it Cancelled/hidden, never Scanned-and-visible.
    if (challenge.status === ChallengeStatus.Scheduled) {
      await voidChallenge(entityId);
      await dbWrite.challenge.update({
        where: { id: entityId },
        data: { ingestion: ChallengeIngestionStatus.Scanned, scannedAt: new Date() },
      });
      if (challenge.createdById) {
        await createNotification({
          userId: challenge.createdById,
          category: NotificationCategory.System,
          type: 'system-message',
          key: `challenge-nsfw-cancelled-${entityId}`,
          details: {
            message:
              'Your challenge was cancelled because its text was flagged as adult content — green challenges must be safe-for-work. Any prize you funded has been refunded; you can recreate it on civitai.red.',
            url: `/challenges/${entityId}`,
          },
        });
      }
      return;
    }

    // Defense-in-depth: a scan verdict reached an already-started (non-Scheduled) green challenge.
    // This should be unreachable post entry-gate (Active challenges are never re-scanned); if the
    // invariant is ever broken, do NOT auto-void a live challenge out from under entrants. Hide it
    // (Blocked ⟹ excluded from feeds) and alert mods to void+refund or override by hand. No auto-
    // refund and no creator "cancelled" notification — a human decides.
    await dbWrite.challenge.update({
      where: { id: entityId },
      data: { ingestion: ChallengeIngestionStatus.Blocked, scannedAt: new Date() },
    });
    logToAxiom({
      type: 'error',
      name: 'challenge-nsfw-escalation-held',
      message: `Green challenge ${entityId} scanned NSFW while ${String(
        challenge.status
      )}; hidden and held for moderator review instead of auto-void.`,
      challengeId: entityId,
      status: String(challenge.status),
    });
    return;
  }

  await dbWrite.challenge.update({
    where: { id: entityId },
    data: {
      ingestion: ChallengeIngestionStatus.Scanned,
      scannedAt: new Date(),
      nsfwLevel: escalation.nsfwLevel,
      allowedNsfwLevel: escalation.allowedNsfwLevel,
    },
  });

  // Keep the collection's entry-gating level in step with the raised allowed level. updateMany (not
  // update) so a deleted collection no-ops instead of throwing P2025 on webhook retries.
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

  if (
    isNsfw &&
    challenge.createdById &&
    escalation.nsfwLevel > deriveBase(challenge.allowedNsfwLevel)
  ) {
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

// The display level implied by the ORIGINAL allowed mask, to detect an actual raise before notifying.
function deriveBase(allowedNsfwLevel: number): number {
  return computeNsfwEscalation({
    allowedNsfwLevel,
    buzzType: 'yellow',
    source: ChallengeSource.User,
    isNsfw: false,
  }).nsfwLevel;
}
