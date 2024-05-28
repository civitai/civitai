import { TrainingStatus } from '@prisma/client';
import { z } from 'zod';
import { updateRecords } from '~/pages/api/webhooks/resource-training';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { refundTransaction } from '~/server/services/buzz.service';
import { createTrainingRequest } from '~/server/services/training.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { withRetries } from '~/server/utils/errorHandling';

const schema = z.object({
  modelVersionId: z.number(),
  approve: z.boolean(),
});

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'resource-training',
      type: 'error',
      ...data,
    },
    'webhooks'
  ).catch();
};

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') {
    logWebhook({ message: 'Wrong method', data: { method: req.method, important: true } });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success) {
    logWebhook({
      message: 'Could not parse body',
      data: { error: bodyResults.error, important: true },
    });
    return res.status(400).json({ ok: false, error: bodyResults.error });
  }

  const { approve, modelVersionId } = bodyResults.data;

  if (approve) {
    logWebhook({ message: 'Approved training dataset', type: 'info', data: { modelVersionId } });

    try {
      // TODO need userId here?
      await createTrainingRequest({ modelVersionId, skipModeration: true });
    } catch (e) {
      logWebhook({
        message: 'Failed to resubmit training request',
        data: {
          modelVersionId,
          important: true,
          error: (e as Error)?.message,
          cause: (e as Error)?.cause,
        },
      });
    }
  } else {
    logWebhook({
      message: 'Denied training dataset',
      type: 'info',
      data: { modelVersionId, important: true },
    });

    let jobId = '(unk jobId)';
    try {
      const modelFile = await dbWrite.modelFile.findFirst({
        where: { modelVersionId },
        select: {
          id: true,
          metadata: true,
        },
      });

      if (!modelFile) {
        logWebhook({
          message: 'Could not find modelFile',
          data: { modelVersionId, important: true },
        });
        return res.status(400).json({ ok: false, error: 'Could not find modelFile' });
      }

      const metadata = modelFile.metadata as FileMetadata;
      jobId = metadata.trainingResults?.jobId ?? '(unk jobId)';
      const transactionId = metadata.trainingResults?.transactionId;
      if (!transactionId) {
        logWebhook({
          message: 'Could not refund user, missing transaction ID',
          data: {
            important: true,
            modelVersionId,
            jobId,
          },
        });
      } else {
        logWebhook({
          type: 'info',
          message: `Attempting to refund user`,
          data: { modelVersionId, jobId },
        });
        try {
          await withRetries(async () =>
            refundTransaction(transactionId, 'Refund for failed training job.')
          );
        } catch (e: unknown) {
          logWebhook({
            message: 'Could not refund user',
            data: {
              error: (e as Error)?.message,
              cause: (e as Error)?.cause,
              jobId,
              transactionId,
              important: true,
            },
          });
        }
      }

      await updateRecords({ modelFileId: modelFile.id }, TrainingStatus.Denied, 'Failed', jobId);
    } catch (e: unknown) {
      logWebhook({
        message: 'Failed to update record',
        data: { error: (e as Error)?.message, cause: (e as Error)?.cause, modelVersionId, jobId },
      });
      return res.status(500).json({ ok: false, error: (e as Error)?.message });
    }
  }

  return res.status(200).json({ ok: true });
});
