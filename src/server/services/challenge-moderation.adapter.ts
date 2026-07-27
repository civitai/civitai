import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { createNotification } from '~/server/services/notification.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { buildChallengeModerationText } from '~/server/games/daily-challenge/challenge-helpers';
import {
  CHALLENGE_MODERATION_LABELS,
  isChallengeTextNsfw,
} from '~/server/games/daily-challenge/challenge-text-scan';
import { logToAxiom } from '~/server/logging/client';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { applyChallengeNsfwEscalation } from '~/server/games/daily-challenge/challenge-nsfw-escalation';
import { ChallengeIngestionStatus } from '~/shared/utils/prisma/enums';
import { recordChallengeScanResult } from '~/server/prom/challenge.metrics';

// Challenge-side hooks for the EntityModeration pipeline, mirroring the Article adapter. The
// webhook and the retry cron route all `Challenge` entityType work through here via the central
// registry in `moderation-adapters.ts`.
//
// Result resolution (same shape as articles):
//   - `blocked`  → ToS violation: hide the challenge (ingestion Blocked) + notify the creator.
//   - not blocked → routed to `applyChallengeNsfwEscalation`, which on an NSFW verdict cancels a
//     green USER challenge (void + refund + notify to recreate on civitai.red) and raises a
//     yellow/non-user challenge to R in place.
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

  applyResult: async ({ entityId, blocked, triggeredLabels, output }) => {
    if (blocked) {
      const challenge = await dbRead.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true, source: true },
      });
      // Deleted between submit and this webhook — nothing to hide or notify (a bare update would
      // throw P2025 and fail the moderation callback).
      if (!challenge) return;
      await dbWrite.challenge.update({
        where: { id: entityId },
        data: { ingestion: ChallengeIngestionStatus.Blocked, scannedAt: new Date() },
      });
      recordChallengeScanResult({ source: challenge.source, result: 'blocked' });
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

    const isNsfw = isChallengeTextNsfw({ results: output?.results, triggeredLabels });

    // A clean challenge scan otherwise leaves no trace anywhere, which is how a batch of
    // under-flagged challenges went unnoticed until testers reported them. Log every verdict with
    // the scores behind it so near-misses are queryable.
    logToAxiom({
      type: isNsfw ? 'warning' : 'info',
      name: 'challenge-text-scan',
      challengeId: entityId,
      isNsfw,
      scores: (output?.results ?? []).map((r) => ({
        label: r.label,
        score: r.score,
        threshold: r.threshold,
        topToken: r.topToken,
      })),
    });

    // Scan verdict telemetry: a not-blocked callback is a 'scanned' outcome (the dominant terminal
    // state). A green-user-challenge NSFW escalation may still hide/void it inside
    // applyChallengeNsfwEscalation, but that void is captured separately by challenge_voided_total —
    // this metric reflects the moderation CALLBACK verdict, not the final ingestion column.
    // Guarded with `.catch(() => null)` (mirrors the applyFailure sibling) so a transient DB hiccup
    // on this TELEMETRY-only read can never throw out of applyResult and skip the real safety step
    // (applyChallengeNsfwEscalation) below. null → source 'unknown' via the normalizer.
    const scanned = await dbRead.challenge
      .findUnique({ where: { id: entityId }, select: { source: true } })
      .catch(() => null);
    recordChallengeScanResult({ source: scanned?.source, result: 'scanned' });

    await applyChallengeNsfwEscalation({ entityId, isNsfw });
  },

  // Terminal scan failure: mark retryable Error (the scan gate keeps the challenge hidden). The
  // generic retry cron re-submits from `retryCount < 9`; the activation job voids past the grace
  // window so escrowed funds aren't stranded forever.
  //
  // Scoped to Pending so a failed moderator rescan (`rescanChallenge`) can't downgrade an already
  // Scanned challenge — that would hide a live one from feeds and 404 its detail page on a
  // transient orchestrator failure, rather than just leaving the prior verdict in place.
  applyFailure: async ({ entityId }) => {
    const res = await dbWrite.challenge
      .updateMany({
        where: { id: entityId, ingestion: ChallengeIngestionStatus.Pending },
        data: { ingestion: ChallengeIngestionStatus.Error },
      })
      .catch(() => undefined);
    // Only count a real Pending→Error terminal transition (not a no-op on an already-Scanned row).
    if (res?.count) {
      const challenge = await dbRead.challenge
        .findUnique({ where: { id: entityId }, select: { source: true } })
        .catch(() => null);
      recordChallengeScanResult({ source: challenge?.source, result: 'error' });
    }
  },
};
