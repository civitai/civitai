import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead } from '~/server/db/client';
import {
  getChallengeConfig,
  getChallengeDetails,
  getChallengeTypeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  generateArticle,
  generateCollectionDetails,
  generateReview,
  generateWinners,
} from '~/server/games/daily-challenge/generative-content';
import { getCoverOfModel, getJudgedEntries } from '~/server/jobs/daily-challenge-processing';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z
  .object({
    action: z.enum(['article', 'collection', 'review', 'winners']),
    modelId: z.coerce.number().optional(),
    type: z.string().optional(),
    imageId: z.coerce.number().optional(),
    theme: z.string().optional(),
    challengeId: z.coerce.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'review' && !data.imageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'imageId is required for action review',
      });
    }

    if (data.action === 'review' && !data.challengeId && !data.theme) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'challengeId or theme is required for action review',
      });
    }

    if (data.action === 'winners' && !data.challengeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'collectionId is required for action winners',
      });
    }

    if ((data.action === 'article' || data.action === 'collection') && !data.modelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
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
      const challengeDetails = await getChallengeDetails(challengeId!);
      theme = challengeDetails.theme;
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
    const challengeDetails = await getChallengeDetails(challengeId!);
    const judgedEntries = await getJudgedEntries(challengeDetails.collectionId, config);

    const result = await generateWinners({
      theme: challengeDetails.theme,
      entries: judgedEntries.map((entry) => ({
        creator: entry.username,
        summary: entry.summary,
        score: entry.score,
      })),
      config: challengeTypeConfig,
    });
    return res.status(200).json(result);
  }

  return res.status(200).json({ how: 'did i get here?' });
});

// Types
// ----------------------------------------------
type RecentEntry = {
  imageId: number;
  userId: number;
  username: string;
  url: string;
};
type SelectedResource = {
  modelId: number;
  creator: string;
  title: string;
};
