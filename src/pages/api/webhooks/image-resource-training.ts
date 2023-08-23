import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { TrainingStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';

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
  modelFileId: z.number(),
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
  workerId: z.string(),
  attempt: z.number(),
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
    Fail: TrainingStatus.Failed,
    Update: TrainingStatus.Processing,
  }[data.type];

  switch (data.type) {
    case 'Success':
    case 'Fail':
    case 'Update':
      // TODO: this validation could be done by zod but would need to handle all the other type cases
      if (!data.context) {
        return res.status(400).json({ ok: false, error: 'context is undefined' });
      }

      if (!data.context?.modelFileId) {
        return res.status(400).json({ ok: false, error: 'modelFileId is undefined' });
      }

      await updateRecords(data.context, status as TrainingStatus);

      break;
    default:
    // TODO: what should we do in the default case...
  }

  return res.status(200).json({ ok: true });
});

async function updateRecords(
  { modelFileId, epochs, start_time, end_time }: ContextProps,
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

  if (typeof modelFile.metadata === 'object') {
    const metadata = modelFile.metadata as Prisma.JsonObject;
    metadata['trainingResults'] = {
      epochs,
      start_time: new Date(start_time * 1000).toISOString(),
      end_time: end_time && new Date(end_time * 1000).toISOString(),
    };
  }

  modelFile.metadata = modelFileMetadataSchema.parse(modelFile.metadata) as Prisma.JsonObject;

  await dbWrite.modelFile.update({
    where: { id: modelFile.id },
    data: {
      metadata: modelFile.metadata,
    },
  });

  await dbWrite.modelVersion.update({
    where: { id: modelFile.modelVersionId },
    data: {
      trainingStatus: status,
    },
  });
}
