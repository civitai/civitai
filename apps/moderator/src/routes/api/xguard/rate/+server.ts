import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getLabDb } from '$lib/server/xguard-lab';
import { labConnectionString, openrouterKey } from '$lib/server/xguard-api';
import { rateBatch } from '../../../../../xguard-lab/rate-core';
import { LABELS, type LabName } from '../../../../../xguard-lab/labels';

// Deliberately synchronous and bounded rather than a background job. A rating pass has no run table to
// poll, so a fire-and-forget call would give a caller no way to learn it failed — and a caller that
// cannot tell success from failure is how a tuning loop ends up measuring nothing. Loop on `remaining`.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const LABEL_NAMES = Object.keys(LABELS) as [LabName, ...LabName[]];

// Clamped rather than rejected, so a caller looping with a too-large page size still makes progress.
const bounded = (fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .default(fallback)
    .transform((n) => Math.min(max, Math.max(1, n)));

export const POST = defineWebhookEndpoint({
  summary:
    'Run the AI rater over unrated samples in a batch. Bounded per call — loop until `remaining` is 0.',
  input: z.object({
    batch: z.string().trim().min(1).max(120).describe('Sampling batch to rate.'),
    label: z.enum(LABEL_NAMES).describe('Which label to rate for.'),
    limit: bounded(DEFAULT_LIMIT, MAX_LIMIT).describe(`Samples this call, 1-${MAX_LIMIT}.`),
    model: z.string().trim().min(1).optional().describe('OpenRouter model. Defaults to the tuned rater.'),
    concurrency: bounded(6, 12).describe('Parallel rater calls, 1-12.'),
  }),
  returns:
    'Counts for this pass (rated, failed, refused), batch-wide verdict totals, and `remaining` unrated samples.',
  notes: [
    'A rater refusal is not a verdict. Refusals are retried on a fallback model and counted; anything both refuse stays unrated.',
    'Ratings are a baseline for a human to confirm, never ground truth on their own.',
    '`remaining` includes samples that failed this pass, so a loop must stop when `rated` is 0 — otherwise a permanently failing sample loops forever.',
  ],
  handler: async ({ batch, label, limit, model, concurrency }) => {
    const summary = await rateBatch({
      connectionString: labConnectionString(),
      batch,
      label,
      limit,
      concurrency,
      model,
      openrouterKey: openrouterKey(),
    });

    // Counted rather than inferred from `rated === limit`, which is wrong on any pass where a row failed.
    const unrated = await getLabDb()
      .selectFrom('sample as s')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('s.batch', '=', batch)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('machine_judgement as m')
              .select('m.id')
              .whereRef('m.sample_id', '=', 's.id')
              .where('m.label', '=', label)
              .where('m.source', '=', 'ai')
          )
        )
      )
      .executeTakeFirst();

    return { ...summary, limit, remaining: Number(unrated?.n ?? 0) };
  },
});
