import * as z from 'zod';
import { blockedCustomModels } from '~/components/Training/Form/TrainingCommon';
import { autoCaptionSchema, autoLabelLimits } from '~/store/training.store';

// Auto-label workflow batches map 1 step per image; the orchestrator can ingest larger
// payloads but 16 fits cleanly into the 64-tasks-per-GPU budget without starving other work.
export const AUTO_LABEL_BATCH_SIZE = 16;

/**
 * @deprecated for orchestrator v2
 */
export const createTrainingRequestSchema = z.object({
  modelVersionId: z.number(),
});

/**
 * @deprecated for orchestrator v2
 */
export const createTrainingRequestDryRunSchema = z.object({
  baseModel: z.string().nullable(),
  isPriority: z.boolean().optional(),
  // cost: z.number().optional(),
});

export type MoveAssetInput = z.infer<typeof moveAssetInput>;
export const moveAssetInput = z.object({
  url: z.url(),
  modelVersionId: z.number().positive(),
});

export type AutoTagInput = z.infer<typeof autoTagInput>;
export const autoTagInput = z.object({
  url: z.url(),
  modelId: z.number().positive(),
});
export type AutoCaptionInput = z.infer<typeof autoCaptionInput>;
export const autoCaptionInput = autoTagInput.merge(autoCaptionSchema.omit({ overwrite: true }));

// --- Auto-label v2 (orchestrator workflows) ---

// Only accept blob URLs we just minted from the orchestrator's v2 blob endpoint.
// Without this, any URL the orchestrator can reach (including internal IPs and
// metadata services) becomes an SSRF vector via mediaUrl.
const ORCHESTRATOR_BLOB_URL_PREFIX = 'https://orchestration-new.civitai.com/v2/consumer/blobs/';

const autoLabelImageSchema = z.object({
  mediaUrl: z
    .url()
    .refine((url) => url.startsWith(ORCHESTRATOR_BLOB_URL_PREFIX), {
      message: 'mediaUrl must point to an orchestrator-issued blob',
    }),
  filename: z.string().min(1).max(256),
});

const autoLabelTagParamsSchema = z.object({
  type: z.literal('tag'),
  threshold: z
    .number()
    .min(autoLabelLimits.tag.threshold.min)
    .max(autoLabelLimits.tag.threshold.max)
    .default(autoLabelLimits.tag.threshold.def),
});

const autoLabelCaptionParamsSchema = z.object({
  type: z.literal('caption'),
  temperature: z
    .number()
    .min(autoLabelLimits.caption.temperature.min)
    .max(autoLabelLimits.caption.temperature.max)
    .default(autoLabelLimits.caption.temperature.def),
  maxNewTokens: z
    .number()
    .int()
    .min(autoLabelLimits.caption.maxNewTokens.min)
    .max(autoLabelLimits.caption.maxNewTokens.max)
    .default(autoLabelLimits.caption.maxNewTokens.def),
});

export type SubmitAutoLabelWorkflowInput = z.infer<typeof submitAutoLabelWorkflowSchema>;
export const submitAutoLabelWorkflowSchema = z.object({
  modelId: z.number().positive(),
  mediaType: z.enum(['image', 'video']).default('image'),
  images: z.array(autoLabelImageSchema).min(1).max(AUTO_LABEL_BATCH_SIZE),
  params: z.discriminatedUnion('type', [autoLabelTagParamsSchema, autoLabelCaptionParamsSchema]),
});

export type GetAutoLabelWorkflowInput = z.infer<typeof getAutoLabelWorkflowSchema>;
export const getAutoLabelWorkflowSchema = z.object({
  workflowId: z.string().min(1),
});

export const trainingServiceStatusSchema = z.object({
  available: z.boolean().default(true),
  message: z.string().nullish(),
  blockedModels: z.array(z.string()).optional().default(blockedCustomModels),
});
export type TrainingServiceStatus = z.infer<typeof trainingServiceStatusSchema>;
