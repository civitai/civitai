import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { WebhookEndpoint } from '$lib/server/webhook-endpoint';
import { ok, readJson, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';
import { labConnectionString, openrouterKey, requireName } from '$lib/server/xguard-api';
import { rateBatch } from '../../../../../xguard-lab/rate-core';
import { LABELS, type LabName } from '../../../../../xguard-lab/labels';

// Deliberately synchronous and bounded rather than a background job. A rating pass has no run table to
// poll, so a fire-and-forget call would give a caller no way to learn it failed — and a caller that
// cannot tell success from failure is how a tuning loop ends up measuring nothing. Loop on `remaining`.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const _doc: EndpointDoc = {
  summary:
    'Run the AI rater over unrated samples in a batch. Bounded per call — loop until `remaining` is 0.',
  params: [
    {
      name: 'batch',
      type: 'string (body)',
      required: true,
      description: 'Sampling batch to rate.',
    },
    {
      name: 'label',
      type: 'string (body)',
      required: true,
      description: `One of: ${Object.keys(LABELS).join(', ')}.`,
    },
    {
      name: 'limit',
      type: 'number (body)',
      description: `Samples this call. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
    },
    {
      name: 'model',
      type: 'string (body)',
      description: 'OpenRouter model. Defaults to the tuned rater.',
    },
    { name: 'concurrency', type: 'number (body)', description: 'Default 6, max 12.' },
  ],
  returns:
    'Counts for this pass (rated, failed, refused), batch-wide verdict totals, and `remaining` unrated samples.',
  notes: [
    'A rater refusal is not a verdict. Refusals are retried on a fallback model and counted; anything both refuse stays unrated.',
    'Ratings are a baseline for a human to confirm, never ground truth on their own.',
    '`remaining` includes samples that failed this pass, so a loop must stop when `rated` is 0 — otherwise a permanently failing sample loops forever.',
  ],
};

export const POST: RequestHandler = WebhookEndpoint(async (event) => {
  const body = await readJson<Record<string, unknown>>(event);

  const batch = requireName(body.batch, 'batch');
  const label = requireName(body.label, 'label') as LabName;
  if (!LABELS[label]) error(400, `label must be one of: ${Object.keys(LABELS).join(', ')}`);

  const rawLimit = Number(body.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : DEFAULT_LIMIT;
  const rawConcurrency = Number(body.concurrency ?? 6);
  const concurrency = Number.isFinite(rawConcurrency)
    ? Math.min(12, Math.max(1, Math.trunc(rawConcurrency)))
    : 6;

  const summary = await rateBatch({
    connectionString: labConnectionString(),
    batch,
    label,
    limit,
    concurrency,
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
    openrouterKey: openrouterKey(),
  });

  // Counted rather than inferred from `rated === limit`, which is wrong on any pass where a row failed.
  const unrated = await labDb
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

  return ok({ ...summary, limit, remaining: Number(unrated?.n ?? 0) });
});
