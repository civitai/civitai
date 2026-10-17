import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { PG_INT4_MAX } from '~/server/common/constants';
import { submitPredictions } from '~/server/services/label-store.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const MAX_PREDICTIONS = 500;

const smallJson = (maxChars: number) =>
  z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= maxChars, {
    message: `At most ${maxChars} characters of JSON.`,
  });

const predictionSchema = z.strictObject({
  subjectType: z.literal('image'),
  subjectId: z.coerce.number().int().positive().max(PG_INT4_MAX).transform(String),
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe('Lowercase hex sha256 of Image.url as stored (the storage key, not a full URL).'),
  question: z
    .string()
    .max(64)
    .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
    .describe('e.g. image.block'),
  questionVersion: z.number().int().min(1).max(1000).optional(),
  value: z.string().trim().min(1).max(64),
  modelRef: z.string().trim().min(1).max(128).describe('model@version'),
  sourceRef: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'Your id for the run or prediction. The same sourceRef again for the same image, question and questionVersion is a duplicate.'
    ),
  predictedAt: z.iso.datetime({ offset: true }).optional(),
  confidence: z.number().min(0).max(1).optional(),
  scores: z
    .record(z.string().max(64), z.number())
    .refine((value) => Object.keys(value).length <= 64, { message: 'At most 64 scores.' })
    .optional(),
  versions: smallJson(1024).optional(),
  inputHash: z.string().max(128).optional(),
  detail: smallJson(2048).optional(),
});

export default defineModeratorEndpoint('labelStore.submitPredictions', {
  summary: 'Record model predictions in the label store.',
  returns:
    "{ results: { sourceRef, status: 'recorded' | 'duplicate' | 'rejected', id?, error? }[] }, in input order",
  notes: [
    'Requires the moderator app permission `labelStore.submitPrediction`.',
    `Up to ${MAX_PREDICTIONS} predictions per call, and a request body under 1 MB.`,
    'Idempotent per (sourceRef, image, question, questionVersion). Each prediction stands alone: one rejected (for example, an erased image) does not reject the rest.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ predictions: z.array(predictionSchema).min(1).max(MAX_PREDICTIONS) }),
  auditExclude: ['predictions'],
  async handler({ predictions }, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'labelStore.submitPrediction')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Submitting predictions needs the "labelStore.submitPrediction" moderator permission.',
      });

    const results = await submitPredictions(predictions);
    return {
      results,
      affected: {
        predictions: predictions.length,
        recorded: results.filter((r) => r.status === 'recorded').length,
      },
    };
  },
});
