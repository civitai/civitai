import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { dbRead, dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  strategyId: z.preprocess((val) => Number(val), z.number()).optional(),
  partnerId: z.preprocess((val) => Number(val), z.number()).optional(),
});

export default async function runModel(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res
      .status(400)
      .json({ error: `Invalid id: ${results.error.flatten().fieldErrors.modelVersionId}` });

  const { modelVersionId, strategyId, partnerId } = results.data;
  if (!modelVersionId) return res.status(420).json({ error: 'Missing modelVersionId' });

  // Get the modelVersion's run strategies and details
  const modelVersion = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId },
    select: {
      id: true,
      model: { select: { id: true, name: true, type: true, nsfw: true } },
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

  // Get selected, partner, or first runStrategy
  let runStrategy: (typeof modelVersion.runStrategies)[0] | undefined;
  if (strategyId) runStrategy = modelVersion.runStrategies.find((x) => x.id == strategyId);
  else if (partnerId)
    runStrategy = modelVersion.runStrategies.find((x) => x.partner.id == partnerId);
  else runStrategy = modelVersion.runStrategies[0];

  if (!runStrategy) return res.status(404).json({ error: "We don't have a way to run that model" });

  // Track activity
  try {
    const track = new Tracker(req, res);
    track.partnerEvent({
      type: 'Run',
      partnerId: runStrategy.partner.id,
      modelId: modelVersion.model.id,
      modelVersionId: modelVersion.id,
      nsfw: modelVersion.model.nsfw,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Invalid database operation', cause: error });
  }

  // Append our QS
  const runUrl = new URL(runStrategy.url);
  if (!runUrl.searchParams.has('utm_source')) runUrl.searchParams.append('utm_source', 'civitai');
  if (!runUrl.searchParams.has('via')) runUrl.searchParams.append('via', 'civitai');

  res.redirect(runUrl.href);
}
