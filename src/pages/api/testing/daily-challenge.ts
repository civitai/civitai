import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead } from '~/server/db/client';
import {
  getChallengeById,
  type RecentEntry,
  type SelectedResource,
} from '~/server/games/daily-challenge/challenge-helpers';
import {
  challengeToLegacyFormat,
  getChallengeConfig,
  getChallengeTypeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  generateArticle,
  generateCollectionDetails,
  generateReview,
  generateWinners,
} from '~/server/games/daily-challenge/generative-content';
import {
  createUpcomingChallenge,
  getCoverOfModel,
  getJudgedEntries,
  pickWinnersForChallenge,
  reviewEntries,
  startScheduledChallenge,
} from '~/server/jobs/daily-challenge-processing';
import {
  getEndedActiveChallenges,
  getChallengesReadyToStart,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z
  .object({
    action: z.enum([
      'article',
      'collection',
      'review',
      'winners',
      'complete-review',
      'complete-challenge',
      'create-challenge',
    ]),
    modelId: z.coerce.number().optional(),
    type: z.string().optional(),
    imageId: z.coerce.number().optional(),
    theme: z.string().optional(),
    challengeId: z.coerce.number().optional(),
    dryRun: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'review' && !data.imageId) {
      ctx.addIssue({
        code: 'custom',
        message: 'imageId is required for action review',
      });
    }

    if (data.action === 'review' && !data.challengeId && !data.theme) {
      ctx.addIssue({
        code: 'custom',
        message: 'challengeId or theme is required for action review',
      });
    }

    if (data.action === 'winners' && !data.challengeId) {
      ctx.addIssue({
        code: 'custom',
        message: 'collectionId is required for action winners',
      });
    }

    if ((data.action === 'article' || data.action === 'collection') && !data.modelId) {
      ctx.addIssue({
        code: 'custom',
        message: 'modelId is required for action article or collection',
      });
    }
  });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.parse(req.query);
  const { action, modelId, type, imageId, challengeId } = payload;
  let { theme } = payload;

  const config = await getChallengeConfig();
  const challengeTypeConfig = await getChallengeTypeConfig(type ?? config.challengeType);

  if (action === 'article' || action === 'collection') {
    // Get resource details
    const [resource] = await dbRead.$queryRaw<SelectedResource[]>`
      SELECT
        m.id as "modelId",
        u."username" as creator,
        m.name as title
      FROM "Model" m
      JOIN "User" u ON u.id = m."userId"
      WHERE m.id = ${modelId}
      LIMIT 1
    `;

    const image = await getCoverOfModel(modelId!);
    if (action === 'article') {
      const result = await generateArticle({
        resource,
        image,
        collectionId: 123,
        challengeDate: new Date(),
        prizes: config.prizes,
        entryPrize: config.entryPrize,
        entryPrizeRequirement: config.entryPrizeRequirement,
        config: challengeTypeConfig,
      });
      return res.status(200).json(result);
    }

    if (action === 'collection') {
      const result = await generateCollectionDetails({
        resource,
        image,
        config: challengeTypeConfig,
      });
      return res.status(200).json(result);
    }
  }

  if (action === 'review') {
    const [entry] = await dbRead.$queryRaw<RecentEntry[]>`
      SELECT
        i."id" as "imageId",
        i."userId",
        u."username",
        i."url"
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId"
      WHERE i.id = ${imageId}
    `;

    if (!theme) {
      const challengeRecord = await getChallengeById(challengeId!);
      if (!challengeRecord) return res.status(404).json({ error: 'Challenge not found' });
      theme = challengeRecord.theme ?? '';
    }

    const result = await generateReview({
      theme,
      creator: entry.username,
      imageUrl: getEdgeUrl(entry.url, { width: 1024 }),
      config: challengeTypeConfig,
    });
    return res.status(200).json(result);
  }

  if (action === 'winners') {
    const challengeRecord = await getChallengeById(challengeId!);
    if (!challengeRecord) return res.status(404).json({ error: 'Challenge not found' });
    const challengeDetails = challengeToLegacyFormat(challengeRecord);
    const judgedEntries = await getJudgedEntries(challengeDetails.collectionId, config);

    const result = await generateWinners({
      theme: challengeRecord.theme ?? '',
      entries: judgedEntries.map((entry) => ({
        creator: entry.username,
        creatorId: entry.userId,
        summary: entry.summary,
        score: entry.score,
      })),
      config: challengeTypeConfig,
    });
    return res.status(200).json(result);
  }

  if (action === 'complete-review') {
    if (payload.dryRun) {
      return res.status(200).json({
        action: 'complete-review',
        dryRun: true,
        message: 'Would execute reviewEntries() to process and review challenge entries',
      });
    }
    await reviewEntries();
    return res.status(200).json({ success: true, action: 'complete-review' });
  }

  if (action === 'complete-challenge') {
    if (payload.dryRun) {
      return res.status(200).json({
        action: 'complete-challenge',
        dryRun: true,
        message: 'Would complete ended challenges and activate scheduled challenges',
      });
    }

    // Complete ended challenges
    const endedChallenges = await getEndedActiveChallenges();
    for (const challenge of endedChallenges) {
      await pickWinnersForChallenge(challenge, config);
    }

    // Activate scheduled challenges
    const challengesToStart = await getChallengesReadyToStart();
    for (const challenge of challengesToStart) {
      await startScheduledChallenge(challenge, config);
    }

    return res.status(200).json({ success: true, action: 'complete-challenge' });
  }

  if (action === 'create-challenge') {
    if (payload.dryRun) {
      return res.status(200).json({
        action: 'create-challenge',
        dryRun: true,
        message: 'Would execute createUpcomingChallenge() to create a new scheduled challenge',
      });
    }
    const challenge = await createUpcomingChallenge();
    return res.status(200).json({ success: true, action: 'create-challenge', challenge });
  }

  return res.status(200).json({ how: 'did i get here?' });
});

// Types imported from challenge-helpers
