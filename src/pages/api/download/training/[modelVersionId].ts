import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import * as z from 'zod';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

// Disable body parser size limit and response size limit for large epoch files
export const config = {
  api: {
    responseLimit: false,
  },
};

const schema = z.object({
  modelVersionId: z.preprocess((val) => Number(val), z.number()),
  epochNumber: z.preprocess((val) => Number(val), z.number()),
});

export default AuthedEndpoint(async function downloadTrainingEpoch(
  req: NextApiRequest,
  res: NextApiResponse,
  user
) {
  const queryResults = schema.safeParse(req.query);
  if (!queryResults.success) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const { modelVersionId, epochNumber } = queryResults.data;

  // Get the model version and verify ownership
  const modelVersion = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      model: { select: { id: true, userId: true, name: true } },
      files: {
        select: { metadata: true },
        where: { type: 'Training Data' },
        take: 1,
      },
    },
  });

  if (!modelVersion) {
    return res.status(404).json({ error: 'Model version not found' });
  }

  // Only the model owner can download training epochs
  if (modelVersion.model.userId !== user.id && !user.isModerator) {
    return res.status(403).json({ error: 'You do not have permission to download this epoch' });
  }

  const trainingFile = modelVersion.files[0];
  if (!trainingFile) {
    return res.status(404).json({ error: 'Training data not found' });
  }

  const metadata = trainingFile.metadata as Record<string, unknown>;
  const trainingResults = metadata?.trainingResults as {
    version?: number;
    epochs?: Array<{
      epochNumber?: number;
      epoch_number?: number;
      modelUrl?: string;
      model_url?: string;
    }>;
  };

  if (!trainingResults?.epochs?.length) {
    return res.status(404).json({ error: 'No training epochs found' });
  }

  const epoch = trainingResults.epochs.find((e) =>
    'epoch_number' in e ? e.epoch_number === epochNumber : e.epochNumber === epochNumber
  );

  if (!epoch) {
    return res.status(404).json({ error: `Epoch ${epochNumber} not found` });
  }

  const epochUrl = 'epoch_number' in epoch ? epoch.model_url : epoch.modelUrl;
  if (!epochUrl) {
    return res.status(404).json({ error: 'Epoch download URL not available' });
  }

  // Fetch from orchestrator using server-side token (bypasses CORS)
  const orchestratorResponse = await fetch(epochUrl, {
    headers: {
      Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
    },
  });

  if (!orchestratorResponse.ok) {
    return res
      .status(orchestratorResponse.status)
      .json({ error: 'Failed to fetch epoch from storage' });
  }

  const modelName = modelVersion.model.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${modelName}_epoch_${epochNumber}.safetensors`;

  // Stream the response to the client
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  const contentLength = orchestratorResponse.headers.get('content-length');
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }

  const body = orchestratorResponse.body;
  if (!body) {
    return res.status(500).json({ error: 'No response body from storage' });
  }

  // Convert Web ReadableStream to Node.js Readable and pipe to response
  const nodeStream = Readable.fromWeb(body as import('stream/web').ReadableStream);
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(res);
    nodeStream.on('error', reject);
    res.on('finish', resolve);
    res.on('error', reject);
  });
},
['GET']);
