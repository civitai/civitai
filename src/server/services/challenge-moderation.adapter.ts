import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { createNotification } from '~/server/services/notification.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import {
  buildChallengeModerationText,
  CHALLENGE_MODERATION_LABELS,
} from '~/server/games/daily-challenge/challenge-helpers';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { applyChallengeNsfwEscalation } from '~/server/games/daily-challenge/challenge-nsfw-escalation';
import { ChallengeIngestionStatus } from '~/shared/utils/prisma/enums';

// Challenge-side hooks for the EntityModeration pipeline, mirroring the Article adapter. The
// webhook and the retry cron route all `Challenge` entityType work through here via the central
// registry in `moderation-adapters.ts`.
//
// Result resolution (same shape as articles):
//   - `blocked`  → ToS violation: hide the challenge (ingestion Blocked) + notify the creator.
//   - not blocked → routed to `applyChallengeNsfwEscalation`, which on an NSFW verdict raises the
//     challenge to R and flips a green USER challenge to yellow (refunding its green initial prize).
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
      labels: [...CHALLENGE_MODERATION_LABELS],
      priority: 'low',
    }),

  applyResult: async ({ entityId, blocked, triggeredLabels }) => {
    if (blocked) {
      const challenge = await dbRead.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      await dbWrite.challenge.update({
        where: { id: entityId },
        data: { ingestion: ChallengeIngestionStatus.Blocked, scannedAt: new Date() },
      });
      if (challenge?.createdById) {
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

    // Any of nsfw / suggestive / explicit crossing threshold escalates the challenge.
    await applyChallengeNsfwEscalation({ entityId, isNsfw: triggeredLabels.length > 0 });
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
