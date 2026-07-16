import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { createNotification } from '~/server/services/notification.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { buildChallengeModerationText } from '~/server/games/daily-challenge/challenge-helpers';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { deriveChallengeNsfwLevel } from '~/server/games/daily-challenge/daily-challenge.utils';
import { ChallengeIngestionStatus } from '~/shared/utils/prisma/enums';

// Challenge-side hooks for the EntityModeration pipeline, mirroring the Article adapter. The
// webhook and the retry cron route all `Challenge` entityType work through here via the central
// registry in `moderation-adapters.ts`.
//
// Result resolution (same shape as articles):
//   - `blocked`  → ToS violation: hide the challenge (ingestion Blocked) + notify the creator.
//   - `nsfw` (not blocked) → keep visible but floor nsfwLevel to R so it drops out of safe feeds.
//   - clean      → visible at the creator's declared level.
// Unlike articles, a challenge's nsfwLevel isn't image-derived, so the R floor is written directly
// rather than recomputed from a SQL aggregate.
export const challengeModerationAdapter: ModerationAdapter = {
  resolveContent: async (ids) => {
    const rows = await dbRead.challenge.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, theme: true, description: true, invitation: true, metadata: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        buildChallengeModerationText({
          ...r,
          themeElements: parseChallengeMetadata(r.metadata).themeElements,
        }),
      ])
    );
  },

  submit: ({ entityId, content }) =>
    submitTextModeration({
      entityType: 'Challenge',
      entityId,
      content,
      labels: ['nsfw'],
      priority: 'low',
    }),

  applyResult: async ({ entityId, blocked, triggeredLabels }) => {
    const challenge = await dbRead.challenge.findUnique({
      where: { id: entityId },
      select: { allowedNsfwLevel: true, createdById: true },
    });
    if (!challenge) return;

    if (blocked) {
      await dbWrite.challenge.update({
        where: { id: entityId },
        data: { ingestion: ChallengeIngestionStatus.Blocked, scannedAt: new Date() },
      });
      if (challenge.createdById) {
        await createNotification({
          userId: challenge.createdById,
          category: NotificationCategory.System,
          type: 'system-message',
          key: `challenge-text-blocked-${entityId}`,
          details: {
            message: 'Your challenge was hidden because its text violates our Terms of Service.',
            url: `/challenges/${entityId}`,
          },
        });
      }
      return;
    }

    const base = deriveChallengeNsfwLevel(challenge.allowedNsfwLevel);
    const isNsfw = triggeredLabels.some((label) => label.toLowerCase() === 'nsfw');
    const nsfwLevel = isNsfw ? Math.max(base, NsfwLevel.R) : base;

    await dbWrite.challenge.update({
      where: { id: entityId },
      data: { ingestion: ChallengeIngestionStatus.Scanned, scannedAt: new Date(), nsfwLevel },
    });

    if (isNsfw && nsfwLevel > base && challenge.createdById) {
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
  },

  // Terminal scan failure: mark retryable Error (the scan gate keeps the challenge hidden). The
  // generic retry cron re-submits from `retryCount < 9`; the activation job voids past the grace
  // window so escrowed funds aren't stranded forever.
  applyFailure: async ({ entityId }) => {
    await dbWrite.challenge
      .update({ where: { id: entityId }, data: { ingestion: ChallengeIngestionStatus.Error } })
      .catch(() => undefined);
  },
};
