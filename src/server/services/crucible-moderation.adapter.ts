import { constants } from '~/server/common/constants';
import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  CHALLENGE_MODERATION_LABELS,
  isChallengeTextNsfw,
} from '~/server/games/daily-challenge/challenge-text-scan';
import { logToAxiom } from '~/server/logging/client';
import {
  buildCrucibleModerationText,
  cancelCrucible,
  claimCrucibleCancellation,
} from '~/server/services/crucible.service';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { createNotification } from '~/server/services/notification.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { Flags } from '~/shared/utils/flags';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';

function notifyCreator({
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

export const crucibleModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.crucible.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, description: true },
    });
    return new Map(rows.map((r) => [r.id, buildCrucibleModerationText(r)]));
  },

  submit: ({ entityId, content }) =>
    submitTextModeration({
      entityType: 'Crucible',
      entityId,
      content,
      labels: [...CHALLENGE_MODERATION_LABELS],
      priority: 'low',
    }),

  applyResult: async ({ entityId, workflowId, blocked, triggeredLabels, output }) => {
    if (blocked) {
      const crucible = await dbRead.crucible.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      // Deleted since submit: a bare update would throw P2025 and fail the moderation callback.
      if (!crucible) return;
      await dbWrite.crucible.update({
        where: { id: entityId },
        data: { ingestion: CrucibleIngestionStatus.Blocked, scannedAt: new Date() },
      });
      await notifyCreator({
        userId: crucible.userId,
        crucibleId: entityId,
        // Per scan: a block after a later edit is a new notice, a redelivery of this one isn't.
        key: `crucible-text-blocked-${workflowId}`,
        message: 'Your crucible was hidden because its text violates our Terms of Service.',
      });
      return;
    }

    const isNsfw = isChallengeTextNsfw({ results: output?.results, triggeredLabels });

    logToAxiom({
      type: isNsfw ? 'warning' : 'info',
      name: 'crucible-text-scan',
      crucibleId: entityId,
      isNsfw,
      scores: (output?.results ?? []).map((r) => ({
        label: r.label,
        score: r.score,
        threshold: r.threshold,
        topToken: r.topToken,
      })),
    });

    await applyCrucibleNsfwEscalation({ entityId, isNsfw });
  },

  // Scoped to Pending so a failed rescan can't hide a crucible that already passed its scan.
  applyFailure: async ({ entityId }) => {
    await dbWrite.crucible
      .updateMany({
        where: { id: entityId, ingestion: CrucibleIngestionStatus.Pending },
        data: { ingestion: CrucibleIngestionStatus.Error },
      })
      .catch(() => undefined);
  },
};

export async function applyCrucibleNsfwEscalation({
  entityId,
  isNsfw,
}: {
  entityId: number;
  isNsfw: boolean;
}): Promise<void> {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: entityId },
    select: {
      userId: true,
      nsfwLevel: true,
      buzzType: true,
      status: true,
      textNsfw: true,
    },
  });
  if (!crucible) return;

  if (!isNsfw) {
    // textNsfw is left alone: a raise is sticky across a later clean rescan, as a challenge's is.
    await dbWrite.crucible.update({
      where: { id: entityId },
      data: { ingestion: CrucibleIngestionStatus.Scanned, scannedAt: new Date() },
    });
    return;
  }

  if (crucible.buzzType !== 'green') {
    await dbWrite.crucible.update({
      where: { id: entityId },
      data: {
        ingestion: CrucibleIngestionStatus.Scanned,
        scannedAt: new Date(),
        textNsfw: true,
        nsfwLevel: Flags.addFlag(crucible.nsfwLevel, NsfwLevel.R),
      },
    });
    if (!crucible.textNsfw) {
      await notifyCreator({
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
      await notifyCreator({
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
