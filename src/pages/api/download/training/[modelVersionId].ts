import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import * as z from 'zod';
import { env } from '~/env/server';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { trainingEpochModelFileName } from '~/shared/utils/training-file-names';
import {
  isTrustedOrchestratorUrl,
  logHostOf,
} from '~/server/services/orchestrator/trusted-blob-url';
import { logToAxiom } from '~/server/logging/client';
import type { TrainingResults } from '~/server/schema/model-file.schema';
import { normalizeEpochs } from '~/server/services/orchestrator/training/epoch-archive';
import { resolveTrainingRun } from '~/server/services/orchestrator/training/training-state';

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

export default AuthedEndpoint(
  async function downloadTrainingEpoch(req: NextApiRequest, res: NextApiResponse, user) {
    const queryResults = schema.safeParse(req.query);
    if (!queryResults.success) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const { modelVersionId, epochNumber } = queryResults.data;

    let resolved: Awaited<ReturnType<typeof resolveTrainingRun>>;
    try {
      resolved = await resolveTrainingRun({
        modelVersionId,
        userId: user.id,
        isModerator: !!user.isModerator,
        ctx: { req, res },
      });
    } catch (error) {
      return handleEndpointError(res, error);
    }
    const { state, run } = resolved;

    const trainingResults = state.trainingResults as TrainingResults | null;
    const epoch = trainingResults
      ? normalizeEpochs(trainingResults).find((e) => e.epochNumber === epochNumber)
      : undefined;
    if (!epoch) {
      return res.status(404).json({ error: `Epoch ${epochNumber} not found` });
    }

    // Stored input; a legacy epoch can carry no URL despite the type.
    const epochUrl = epoch.modelUrl as string | undefined;
    if (!epochUrl) {
      return res.status(404).json({ error: 'Epoch download URL not available' });
    }

    // epochUrl is untrusted stored input — see isTrustedOrchestratorUrl.
    if (!isTrustedOrchestratorUrl(epochUrl)) {
      logToAxiom(
        {
          name: 'training-epoch-download',
          type: 'warning',
          message: 'Refused to fetch an epoch URL outside the orchestrator hosts',
          data: { modelVersionId, epochNumber, userId: user.id, host: logHostOf(epochUrl) },
        },
        'webhooks'
      ).catch();
      return res.status(404).json({ error: 'Epoch download URL not available' });
    }

    // Abort the upstream fetch + stream when the client disconnects.
    // Without this, a client hang or Traefik timeout leaves the pod streaming
    // into a dead socket for minutes, holding an event-loop slot.
    const abortController = new AbortController();
    const onClientClose = () => abortController.abort();
    req.on('close', onClientClose);

    // Fetch from orchestrator using server-side token (bypasses CORS)
    let orchestratorResponse: Response;
    try {
      orchestratorResponse = await fetch(epochUrl, {
        headers: {
          Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
        },
        signal: abortController.signal,
      });
    } catch (err) {
      req.off('close', onClientClose);
      if (abortController.signal.aborted) return res.end();
      throw err;
    }

    if (!orchestratorResponse.ok) {
      req.off('close', onClientClose);
      return res
        .status(orchestratorResponse.status)
        .json({ error: 'Failed to fetch epoch from storage' });
    }

    const fileName = trainingEpochModelFileName({ ...run, epochNumber });

    // Stream the response to the client
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const contentLength = orchestratorResponse.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const body = orchestratorResponse.body;
    if (!body) {
      req.off('close', onClientClose);
      return res.status(500).json({ error: 'No response body from storage' });
    }

    // Convert Web ReadableStream to Node.js Readable and pipe to response.
    // Destroy the stream on client disconnect so we stop reading from the orchestrator.
    const nodeStream = Readable.fromWeb(body as NodeReadableStream);
    const onClientCloseStream = () => nodeStream.destroy();
    req.on('close', onClientCloseStream);

    try {
      await new Promise<void>((resolve, reject) => {
        nodeStream.pipe(res);
        nodeStream.on('error', (err) => {
          // Aborted by client disconnect — not an error condition for us.
          if (abortController.signal.aborted) return resolve();
          reject(err);
        });
        res.on('finish', resolve);
        res.on('error', reject);
      });
    } finally {
      req.off('close', onClientClose);
      req.off('close', onClientCloseStream);
    }
  },
  ['GET']
);
