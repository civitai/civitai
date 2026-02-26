import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  getChallengeById,
  type RecentEntry,
} from '~/server/games/daily-challenge/challenge-helpers';
import {
  getChallengeConfig,
  getJudgingConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { generateReview } from '~/server/games/daily-challenge/generative-content';
import { logToAxiom } from '~/server/logging/client';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { upsertComment } from '~/server/services/commentsv2.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { withRetries } from '~/server/utils/errorHandling';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const log = createLogger('api:daily-challenge-re-review', 'magenta');

const schema = z.object({
  challengeId: z.coerce.number(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'challengeId is required' });
  }
  const { challengeId } = parsed.data;

  // Load challenge
  const challenge = await getChallengeById(challengeId);
  if (!challenge) {
    return res.status(404).json({ error: 'Challenge not found' });
  }
  if (challenge.status !== ChallengeStatus.Active) {
    return res.status(400).json({ error: `Challenge is not active (status: ${challenge.status})` });
  }
  if (!challenge.judgeId) {
    return res.status(400).json({ error: 'Challenge has no judge configured' });
  }
  if (!challenge.collectionId) {
    return res.status(400).json({ error: 'Challenge has no collection' });
  }
  if (!challenge.theme) {
    return res.status(400).json({ error: 'Challenge has no theme' });
  }

  // Load judge config (respects per-challenge prompt override)
  const judgingConfig = await getJudgingConfig(challenge.judgeId, challenge.judgingPrompt);
  const config = await getChallengeConfig();
  const metadata = parseChallengeMetadata(challenge.metadata);
  const themeElements = metadata.themeElements;

  // Fetch all judged entries with their existing judge comment IDs
  type EntryWithComment = RecentEntry & { judgeCommentId: number | null };
  const entries = await dbRead.$queryRaw<EntryWithComment[]>`
    SELECT ci."imageId", i."userId", u."username", i."url",
      (
        SELECT cv2.id
        FROM "Thread" t
        JOIN "CommentV2" cv2 ON cv2."threadId" = t.id
        WHERE t."imageId" = ci."imageId"
          AND cv2."userId" = ${judgingConfig.userId}
        ORDER BY cv2."createdAt" DESC
        LIMIT 1
      ) as "judgeCommentId"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE ci."collectionId" = ${challenge.collectionId}
      AND ci.status = 'ACCEPTED'
      AND ci."tagId" = ${config.judgedTagId}
      AND ci.note IS NOT NULL
  `;

  if (entries.length === 0) {
    return res.status(200).json({
      challengeId,
      total: 0,
      successes: 0,
      failures: 0,
    });
  }

  log(`Re-reviewing ${entries.length} entries for challenge ${challengeId}`);

  let successes = 0;
  let failures = 0;
  const failedEntries: { imageId: number; url: string; error: string }[] = [];

  // Process all entries with limited concurrency to avoid rate limits
  const tasks = entries.map((entry) => async () => {
    try {
      log('Re-reviewing entry:', entry.imageId);
      const review = await withRetries(
        () =>
          generateReview({
            theme: challenge.theme!,
            creator: entry.username,
            imageUrl: getEdgeUrl(entry.url, { original: true, optimized: true, quality: 90 }),
            config: judgingConfig,
            themeElements,
          }),
        2,
        1000
      );
      log('Review generated', entry.imageId, review.score);

      // Overwrite score note on collection item
      const note = JSON.stringify({
        score: review.score,
        summary: review.summary,
        judgeId: judgingConfig.judgeId,
        ...(review.aestheticFlaws?.length && { aestheticFlaws: review.aestheticFlaws }),
      });
      await dbWrite.$executeRaw`
        UPDATE "CollectionItem"
        SET note = ${note}
        WHERE "collectionId" = ${challenge.collectionId}
          AND "imageId" = ${entry.imageId}
      `;

      // Update existing judge comment in-place, or create if none exists
      await upsertComment({
        ...(entry.judgeCommentId !== null ? { id: entry.judgeCommentId } : {}),
        userId: judgingConfig.userId,
        entityType: 'image',
        entityId: entry.imageId,
        content: review.comment,
      });

      successes++;
      log('Re-review complete', entry.imageId);
    } catch (error) {
      failures++;
      const err = error as Error;
      failedEntries.push({
        imageId: entry.imageId,
        url: getEdgeUrl(entry.url, { original: true, optimized: true, quality: 90 }),
        error: err.message,
      });
      logToAxiom({
        type: 'error',
        name: 'daily-challenge-re-review-error',
        challengeId,
        imageId: entry.imageId,
        message: 'Failed to re-review entry',
        error: err.message,
        stack: err.stack,
      });
      log('Failed to re-review entry', entry.imageId, error);
    }

    log(
      `Progress: ${successes + failures}/${entries.length} (${successes} ok, ${failures} failed)`
    );
  });

  try {
    await limitConcurrency(tasks, 10);
  } catch (error) {
    const err = error as Error;
    logToAxiom({
      type: 'error',
      name: 'daily-challenge-re-review-fatal',
      challengeId,
      message: 'Fatal error during re-review process',
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({
      error: 'Re-review process failed unexpectedly',
      challengeId,
      successes,
      failures,
      failedEntries,
    });
  }

  log(`Re-review complete: ${successes} successes, ${failures} failures`);
  return res.status(200).json({
    challengeId,
    total: entries.length,
    successes,
    failures,
    ...(failedEntries.length > 0 && { failedEntries }),
  });
});
