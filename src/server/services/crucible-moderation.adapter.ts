import { dbRead, dbWrite } from '~/server/db/client';
import {
  CHALLENGE_MODERATION_LABELS,
  isChallengeTextNsfw,
} from '~/server/games/daily-challenge/challenge-text-scan';
import { logToAxiom } from '~/server/logging/client';
import {
  applyCrucibleNsfwEscalation,
  notifyCrucibleCreator,
} from '~/server/services/crucible-nsfw-escalation';
import { buildCrucibleModerationText } from '~/server/services/crucible.service';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import {
  applyCrucibleTextScan,
  settleSkippedCrucibleScan,
} from '~/server/services/text-scan/actions/crucible';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { CrucibleIngestionStatus } from '~/shared/utils/prisma/enums';

export const crucibleModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.crucible.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, description: true },
    });
    return new Map(rows.map((r) => [r.id, buildCrucibleModerationText(r)]));
  },

  // Only the retry cron calls submit.
  submit: ({ entityId, content }) =>
    submitTextModerationOrScan({
      entityType: 'Crucible',
      entityId,
      fromRetry: true,
      onActiveSkip: (reason) => settleSkippedCrucibleScan(entityId, reason),
      xguard: () =>
        submitTextModeration({
          entityType: 'Crucible',
          entityId,
          content,
          labels: [...CHALLENGE_MODERATION_LABELS],
          priority: 'low',
        }),
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
      await notifyCrucibleCreator({
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

  applyTextScan: applyCrucibleTextScan,
};
