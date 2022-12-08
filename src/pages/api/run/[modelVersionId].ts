import { NextApiRequest, NextApiResponse } from 'next';
import { getGetUrl } from '~/utils/s3-utils';
import { ModelFileType, ModelType, UserActivityType } from '@prisma/client';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { prisma } from '~/server/db/client';
import { filenamize } from '~/utils/string-helpers';
import { z } from 'zod';
import { env } from '~/env/server.mjs';

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  strategyId: z.preprocess((val) => Number(val), z.number()).optional(),
});

export default async function runModel(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res
      .status(400)
      .json({ error: `Invalid id: ${results.error.flatten().fieldErrors.modelVersionId}` });

  const { modelVersionId, strategyId } = results.data;
  if (!modelVersionId) return res.status(400).json({ error: 'Missing modelVersionId' });

  // Get the modelVersion's run strategies and details
  const modelVersion = await prisma.modelVersion.findFirst({
    where: { id: modelVersionId },
    select: {
      id: true,
      model: { select: { id: true, name: true, type: true } },
      name: true,
      trainedWords: true,
      runStrategies: {
        select: {
          id: true,
          url: true,
          partner: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });
  if (!modelVersion) return res.status(404).json({ error: 'Model not found' });

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;

  // Get selected, preferred, or first runStrategy
  if (!strategyId && userId != null) {
    // Get preferred user strategy
    // strategyId = somethingToGetPreferredStrat(modelVersion.runStrategies);
  }
  const runStrategy = strategyId
    ? modelVersion.runStrategies.find((x) => x.id == strategyId)
    : modelVersion.runStrategies[0];
  if (!runStrategy) return res.status(404).json({ error: "We don't have a way to run that model" });

  // Track activity
  try {
    await prisma.userActivity.create({
      data: {
        userId,
        activity: UserActivityType.ModelRun,
        details: {
          modelId: modelVersion.model.id,
          modelVersionId: modelVersion.id,
          partnerId: runStrategy.partner.id,
          strategyId: runStrategy.id,
          partnerName: runStrategy.partner.name,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Invalid database operation', cause: error });
  }

  // Append our QS
  const runUrl = new URL(runStrategy.url);
  runUrl.searchParams.append('utm_source', 'civitai');

  res.redirect(runUrl.href);
}
