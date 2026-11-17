import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { modelMetrics } from '~/server/metrics';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  modelIds: commaDelimitedNumberArray(),
});

export default ModEndpoint(
  async function queueModelMetricUpdate(req: NextApiRequest, res: NextApiResponse) {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
    }

    const { modelIds } = parsed.data;

    try {
      await modelMetrics.queueUpdate(modelIds);

      return res.status(200).json({ success: true, queuedCount: modelIds.length, modelIds });
    } catch (e) {
      const err = e as Error;

      logToAxiom({
        type: 'mod-queue-model-metric-update-error',
        error: err.message,
        cause: err.cause,
        stack: err.stack,
      });

      return res.status(500).json({ error: err.message });
    }
  },
  ['GET']
);
