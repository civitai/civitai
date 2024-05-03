import { TrainingStatus } from '@prisma/client';
import * as z from 'zod';
import { env } from '~/env/server.mjs';
import { SignalMessages } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { trainingCompleteEmail, trainingFailEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { refundTransaction } from '~/server/services/buzz.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { withRetries } from '~/server/utils/errorHandling';

export type EpochSchema = z.infer<typeof epochSchema>;
const epochSchema = z.object({
  epoch_number: z.number(),
  model_url: z.string(),
  sample_images: z
    .array(
      z.object({
        image_url: z.string(),
        prompt: z.string(),
      })
    )
    .optional(),
});

type ContextProps = z.infer<typeof context>;
const context = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  model: z.string().optional(),
  start_time: z.number().optional(),
  end_time: z.number().optional(),
  duration: z.number().optional(),
  epochs: z.array(epochSchema).optional(),
  upload_duration: z.number().optional(),
  sample_prompts: z.array(z.string()).optional(),
  logs: z
    .object({
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    })
    .optional(),
});

const schema = z.object({
  jobId: z.string(),
  type: z.string(), // JobStatus
  dateTime: z.string(),
  // serviceProvider: z.string().nullish(),
  workerId: z.string().nullish(),
  context: context.nullish(),
  claimDuration: z.string().nullish(),
  jobDuration: z.string().nullish(),
  retryAttempt: z.number().nullish(),
  // cost: z.number().nullish(),
  jobProperties: z.object({
    transactionId: z.string(),
    modelFileId: z.number().gt(0),
    // userId: z.number(),
  }),
  jobHasCompleted: z.boolean(),
});

// Initialized, Claimed, Rejected, LateRejected, ClaimExpired, Updated, Failed, Succeeded, Expired, Deleted, Canceled
const mapTrainingStatus = {
  Updated: TrainingStatus.Processing,
  Succeeded: TrainingStatus.InReview,
  Failed: TrainingStatus.Failed,
  Rejected: TrainingStatus.Processing,
  LateRejected: TrainingStatus.Processing,
  Deleted: TrainingStatus.Failed,
  Canceled: TrainingStatus.Failed,
  Expired: TrainingStatus.Failed,
} as const;

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
    logWebhook({ message: 'Wrong method', data: { method: req.method } });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success) {
    logWebhook({ message: 'Could not parse body', data: { error: bodyResults.error } });
    return res.status(400).json({ ok: false, errors: bodyResults.error });
  }

  const data = bodyResults.data;

  if (['Deleted', 'Canceled', 'Expired', 'Failed'].includes(data.type)) {
    logWebhook({
      type: 'info',
      message: `Attempting to refund user`,
      data: { type: data.type, jobId: data.jobId, transactionId: data.jobProperties.transactionId },
    });
    try {
      await withRetries(async () =>
        refundTransaction(data.jobProperties.transactionId, 'Refund for failed training job.')
      );
    } catch (e: unknown) {
      logWebhook({
        message: 'Could not refund user',
        data: {
          error: (e as Error)?.message,
          cause: (e as Error)?.cause,
          jobId: data.jobId,
          transactionId: data.jobProperties.transactionId,
        },
      });
    }
  }

  switch (data.type) {
    case 'Updated':
    case 'Succeeded':
    case 'Failed':
    case 'Rejected':
    case 'LateRejected':
    case 'Deleted':
    case 'Canceled':
    case 'Expired':
      const status = mapTrainingStatus[data.type];

      try {
        await updateRecords(
          { ...(data.context ?? {}), modelFileId: data.jobProperties.modelFileId },
          status,
          data.type,
          data.jobId
        );
      } catch (e: unknown) {
        logWebhook({
          message: 'Failed to update record',
          data: { error: (e as Error)?.message, cause: (e as Error)?.cause, jobId: data.jobId },
        });
        return res.status(500).json({ ok: false, error: (e as Error)?.message });
      }

      break;
    case 'Initialized':
    case 'Claimed':
    case 'ClaimExpired':
      break;
    default:
      logWebhook({
        message: 'Type not supported',
        data: { type: data.type, jobId: data.jobId },
      });
      return res.status(400).json({ ok: false, error: 'type not supported' });
  }

  return res.status(200).json({ ok: true });
});

async function updateRecords(
  { modelFileId, message, epochs, start_time, end_time }: ContextProps & { modelFileId: number },
  status: TrainingStatus,
  orchStatus: string, // JobStatus
  jobId: string
) {
  const modelFile = await dbWrite.modelFile.findFirst({
    where: { id: modelFileId },
  });

  if (!modelFile) {
    throw new Error(`ModelFile not found: "${modelFileId}"`);
  }

  const thisMetadata = (modelFile.metadata ?? {}) as FileMetadata;
  const trainingResults = thisMetadata.trainingResults || {};
  const history = trainingResults.history || [];

  const last = history[history.length - 1];
  if (!last || last.status !== status) {
    // push to history
    history.push({
      time: new Date().toISOString(),
      status,
      message,
    });
  }

  let attempts = trainingResults.attempts || 0;
  if (['Rejected', 'LateRejected'].includes(orchStatus)) {
    attempts += 1;
  }

  const metadata = {
    ...thisMetadata,
    trainingResults: {
      ...trainingResults,
      epochs: epochs ?? [],
      attempts: attempts,
      history: history,
      start_time:
        trainingResults.start_time ||
        (start_time ? new Date(start_time * 1000).toISOString() : null),
      end_time: end_time && new Date(end_time * 1000).toISOString(),
    },
  };

  await dbWrite.modelFile.update({
    where: { id: modelFile.id },
    data: {
      metadata,
    },
  });

  const modelVersion = await dbWrite.modelVersion.update({
    where: { id: modelFile.modelVersionId },
    data: {
      trainingStatus: status,
    },
  });

  const model = await dbWrite.model.findFirst({
    where: { id: modelVersion.modelId },
    select: {
      id: true,
      name: true,
      user: {
        select: {
          id: true,
          email: true,
          username: true,
        },
      },
    },
  });
  if (!model || !model.user) return;

  try {
    await fetch(
      `${env.SIGNALS_ENDPOINT}/users/${model.user.id}/signals/${SignalMessages.TrainingUpdate}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: model.id, status, fileMetadata: metadata }),
      }
    );
  } catch (e: unknown) {
    logWebhook({
      message: 'Failed to send signal for update',
      data: { error: (e as Error)?.message, cause: (e as Error)?.cause, jobId },
    });
  }

  if (status === 'InReview') {
    await trainingCompleteEmail.send({
      model,
      user: model.user,
    });
  } else if (status === 'Failed') {
    await trainingFailEmail.send({
      model,
      user: model.user,
    });
  }
}
