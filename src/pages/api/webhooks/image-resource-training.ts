import { Prisma, TrainingStatus } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { TrainingResults, modelFileMetadataSchema } from '~/server/schema/model-file.schema';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export type EpochSchema = z.infer<typeof epoch_schema>;

const epoch_schema = z.object({
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
  epochs: z.array(epoch_schema).optional(),
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
  type: z.string(),
  jobId: z.string(),
  date: z.string(),
  duration: z.string().optional(),
  totalDuration: z.string().optional(),
  workerId: z.string().optional(),
  attempt: z.number().optional(),
  context: context.nullable(),
});

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success) {
    return res.status(400).json({ ok: false, errors: bodyResults.error });
  }

  const data = bodyResults.data;

  const status = {
    Success: TrainingStatus.InReview,
    Update: TrainingStatus.Processing,
    Fail: TrainingStatus.Failed,
    Reject: TrainingStatus.Failed,
    LateReject: TrainingStatus.Failed,
  }[data.type];

  switch (data.type) {
    case 'Success':
    case 'Fail':
    case 'Reject':
    case 'LateReject':
    case 'Update':
      if (!data.context) {
        return res.status(400).json({ ok: false, error: 'context is undefined' });
      }

      try {
        await updateRecords({ ...data.context, jobId: data.jobId }, status as TrainingStatus);
      } catch (e: unknown) {
        return res.status(500).json({ ok: false, error: (e as Error)?.message });
      }

      break;
    // cannot do anything with Expire and Claim until we store the jobId
    case 'Expire':
    case 'Claim':
    default:
      return res.status(400).json({ ok: false, error: 'type not supported' });
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
    throw new Error('ModelFile not found');
  }

  if (!modelFile.metadata) {
    modelFile.metadata = {};
  }

  modelFile.metadata = modelFileMetadataSchema.parse(modelFile.metadata) as Prisma.JsonObject;

  const trainingResults = (modelFile.metadata.trainingResults as TrainingResults) || {};
  const history = trainingResults.history || [];

  let attempts = trainingResults.attempts || 0;
  if (status !== TrainingStatus.Processing) {
    // increment attempts
    attempts += 1;

    // push to history
    history.push({
      jobId: jobId,
      jobToken: history[history.length - 1]?.jobToken,
      status,
      message,
    });
  }

  const metadata = {
    ...modelFile.metadata,
    trainingResults: {
      ...trainingResults,
      epochs: epochs,
      attempts: attempts,
      history: history,
      start_time: (trainingResults.start_time || new Date(start_time * 1000)).toISOString(),
      end_time: end_time && new Date(end_time * 1000).toISOString(),
    },
  };

  console.log('new metadata', metadata);
  console.log('last token', history[history.length - 1]?.jobToken);

  await dbWrite.modelFile.update({
    where: { id: modelFile.id },
    data: {
      metadata,
    },
  });

  await dbWrite.modelVersion.update({
    where: { id: modelFile.modelVersionId },
    data: {
      trainingStatus: status,
    },
  });
}
