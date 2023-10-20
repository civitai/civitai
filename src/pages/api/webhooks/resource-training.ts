import { TrainingStatus } from '@prisma/client';
import * as z from 'zod';
import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { trainingCompleteEmail } from '~/server/email/templates';
import { refundTransaction } from '~/server/services/buzz.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

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
  modelFileId: z.number().gt(0),
  status: z.string(),
  message: z.string().optional(),
  model: z.string(),
  start_time: z.number(),
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
  type: z.string(),
  dateTime: z.string(),
  // serviceProvider: z.string().nullish(),
  workerId: z.string().nullish(),
  context: context.nullable(),
  claimDuration: z.string().nullish(),
  jobDuration: z.string().nullish(),
  retryAttempt: z.number().nullish(),
  // cost: z.number().nullish(),
  jobProperties: z.object({
    transactionId: z.string(),
    // userId: z.number(),
  }),
  jobHasCompleted: z.boolean(),
});

// breaking change
export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success) {
    return res.status(400).json({ ok: false, errors: bodyResults.error });
  }

  const data = bodyResults.data;

  // Initialized, Claimed, Rejected, LateRejected, ClaimExpired, Updated, Failed, Succeeded, Expired, Deleted
  const status = {
    Succeeded: TrainingStatus.InReview,
    Updated: TrainingStatus.Processing,
    Failed: TrainingStatus.Failed,
    Rejected: TrainingStatus.Failed,
    LateRejected: TrainingStatus.Failed,
    Deleted: TrainingStatus.Failed,
    Expired: TrainingStatus.Failed,
  }[data.type];

  switch (data.type) {
    case 'Succeeded':
    case 'Failed':
    case 'Rejected':
    case 'LateRejected':
    case 'Updated':
      if (!data.context) {
        return res.status(400).json({ ok: false, error: 'context is undefined' });
      }

      try {
        await updateRecords({ ...data.context, jobId: data.jobId }, status as TrainingStatus);
      } catch (e: unknown) {
        return res.status(500).json({ ok: false, error: (e as Error)?.message });
      }

      break;
    case 'Initialized':
    case 'Claimed':
    case 'ClaimExpired':
    case 'Deleted':
    case 'Expired':
      break;
    default:
      return res.status(400).json({ ok: false, error: 'type not supported' });
  }

  if (['Deleted', 'Expired', 'Failed'].includes(data.type)) {
    // nb: in the case of deleted or expired, the job history will not be updated (and the user won't see it)
    await refundTransaction(data.jobProperties.transactionId, 'Refund for failed training job.');
  }

  return res.status(200).json({ ok: true });
});

async function updateRecords(
  { modelFileId, message, epochs, start_time, end_time, jobId }: ContextProps & { jobId: string },
  status: TrainingStatus
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
      jobId: jobId,
      // last should always be present for new jobs and have a jobToken
      jobToken: last?.jobToken || '',
      time: new Date().toISOString(),
      status,
      message,
    });
  }

  let attempts = trainingResults.attempts || 0;
  if (status === TrainingStatus.Failed) {
    attempts += 1;
  }

  const metadata = {
    ...thisMetadata,
    trainingResults: {
      ...trainingResults,
      epochs: epochs,
      attempts: attempts,
      history: history,
      start_time: trainingResults.start_time || new Date(start_time * 1000).toISOString(),
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

  if (status === 'InReview') {
    await trainingCompleteEmail.send({
      model,
      user: model.user,
    });
  }

  await fetch(`${env.SIGNALS_ENDPOINT}/users/${model.user.id}/signals/training:update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: model.id, status, fileMetadata: metadata }),
  });
}
