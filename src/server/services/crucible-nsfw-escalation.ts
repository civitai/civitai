import { constants } from '~/server/common/constants';
import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { cancelCrucible, claimCrucibleCancellation } from '~/server/services/crucible.service';
import { createNotification } from '~/server/services/notification.service';
import { Flags } from '~/shared/utils/flags';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';

export function notifyCrucibleCreator({
  userId,
  crucibleId,
  key,
  message,
}: {
  userId: number;
  crucibleId: number;
  key: string;
  message: string;
}) {
  return createNotification({
    userId,
    category: NotificationCategory.System,
    type: 'system-message',
    key: `${key}-${crucibleId}`,
    details: { message, url: `/crucibles/${crucibleId}` },
  });
}

export async function applyCrucibleNsfwEscalation({
  entityId,
  isNsfw,
  greenCancels = true,
}: {
  entityId: number;
  isNsfw: boolean;
  // False under text-scan: an R+ verdict raises a green crucible to R rather than cancelling it.
  greenCancels?: boolean;
}): Promise<void> {
  // Primary: a moderator rating written just before this callback must be seen.
  const crucible = await dbWrite.crucible.findUnique({
    where: { id: entityId },
    select: {
      userId: true,
      nsfwLevel: true,
      buzzType: true,
      status: true,
      textNsfw: true,
      moderatorNsfwLevel: true,
    },
  });
  if (!crucible) return;

  // textNsfw is left alone: a raise is sticky across a later clean rescan, as a challenge's is.
  // Once a moderator has rated it, a later verdict never raises it, whatever the text; a rescan
  // only settles visibility.
  const settle = () =>
    dbWrite.crucible.update({
      where: { id: entityId },
      data: { ingestion: CrucibleIngestionStatus.Scanned, scannedAt: new Date() },
    });

  if (!isNsfw || crucible.moderatorNsfwLevel != null) {
    await settle();
    return;
  }

  if (crucible.buzzType !== 'green' || !greenCancels) {
    // The read above is unlocked, so a moderator rating can commit before this write; the
    // condition keeps the raise from landing over it.
    const { count } = await dbWrite.crucible.updateMany({
      where: { id: entityId, moderatorNsfwLevel: null },
      data: {
        ingestion: CrucibleIngestionStatus.Scanned,
        scannedAt: new Date(),
        textNsfw: true,
        nsfwLevel: Flags.addFlag(crucible.nsfwLevel, NsfwLevel.R),
      },
    });
    if (count === 0) {
      await settle();
      return;
    }
    if (!crucible.textNsfw) {
      await notifyCrucibleCreator({
        userId: crucible.userId,
        crucibleId: entityId,
        key: 'crucible-nsfw-raised',
        message:
          "Your crucible's rating was raised to R based on its text, so people browsing safe-for-work content won't see it.",
      });
    }
    return;
  }

  // Claimed here rather than by cancelCrucible, so `claimed` tells our cancel apart from an
  // earlier moderator's.
  const claimed = await claimCrucibleCancellation(entityId);

  // Already Cancelled: our own claim from an earlier delivery that died before its refunds, or a
  // moderator's cancel. Re-running is safe either way: cancelCrucible's refunds are idempotent.
  if (claimed || crucible.status === CrucibleStatus.Cancelled) {
    // Cancel before the scan-state write, so a crash in between leaves it Cancelled rather than
    // Scanned and visible.
    const { failedRefunds } = await cancelCrucible({
      id: entityId,
      userId: constants.system.user.id,
      isModerator: true,
    });
    await dbWrite.crucible.update({
      where: { id: entityId },
      data: { ingestion: CrucibleIngestionStatus.Blocked, scannedAt: new Date() },
    });
    // A system cancel has no caller to read `failedRefunds`, so this is the only record of Buzz
    // still owed.
    if (failedRefunds.length) {
      logToAxiom({
        type: 'error',
        name: 'crucible-nsfw-escalation-refund-failed',
        message: `Green crucible ${entityId} was cancelled for NSFW text but ${failedRefunds.length} refund(s) failed; re-run cancelCrucible to finish.`,
        crucibleId: entityId,
        failedRefunds,
      });
    }
    // Only for our own cancel; a moderator's earlier cancel wasn't about the text.
    if (claimed)
      await notifyCrucibleCreator({
        userId: crucible.userId,
        crucibleId: entityId,
        key: 'crucible-nsfw-cancelled',
        message: `Your crucible was cancelled because its text was flagged as adult content — green crucibles must be safe-for-work. ${
          failedRefunds.length
            ? 'Refunds are being processed'
            : 'Your Buzz and any entry fees have been refunded'
        }; you can recreate it on civitai.red.`,
      });
    return;
  }

  // Completed, or Active past endAt: prizes are paid or being paid, so a refund would double-spend.
  await dbWrite.crucible.update({
    where: { id: entityId },
    data: { ingestion: CrucibleIngestionStatus.Blocked, scannedAt: new Date() },
  });
  logToAxiom({
    type: 'error',
    name: 'crucible-nsfw-escalation-held',
    message: `Green crucible ${entityId} scanned NSFW while ${crucible.status}; hidden and held for moderator review — not auto-refunded.`,
    crucibleId: entityId,
    status: crucible.status,
  });
}
