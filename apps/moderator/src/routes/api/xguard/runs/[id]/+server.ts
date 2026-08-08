import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { sql } from '@civitai/db/kysely';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { labDb } from '$lib/server/xguard-lab';
import { precisionOf, recallOf } from '$lib/eval-metrics';
import { idOf } from '$lib/server/xguard-api';

const BUCKETS = ['TP', 'FP', 'TN', 'FN', 'error'] as const;
type Bucket = (typeof BUCKETS)[number];

function bucketsFor(filter: 'wrong' | 'all' | Bucket): Bucket[] {
  if (filter === 'all') return [...BUCKETS];
  if (filter === 'wrong') return ['FP', 'FN'];
  return [filter];
}

export const GET = defineWebhookEndpoint({
  summary: 'One evaluation run: its counters, and the per-sample rows behind them.',
  input: z.object({
    id: z
      .string()
      .regex(/^\d+$/, 'id must be numeric')
      .describe('Run id from POST /api/xguard/runs.'),
    bucket: z
      .enum(['wrong', 'all', ...BUCKETS])
      .default('wrong')
      .describe('Which rows to return. "wrong" is FP + FN — the ones worth reading.'),
    // Clamped rather than rejected, so a caller looping with a too-large page size still makes progress;
    // junk (`limit=all`) is still an error, which a broken caller loop should be.
    limit: z
      .coerce.number()
      .int()
      .default(100)
      .transform((n) => Math.min(1000, Math.max(1, n)))
      .describe('Rows to return, 1-1000.'),
  }),
  returns:
    'run (with derived precision/recall and `status`), bucketCounts, and the requested result rows with prompt text.',
  notes: [
    'Poll `status`: "running" until the scan finishes, then "complete" or "error". An errored run carries the reason in `note`.',
    'precision and recall are null, not 0, when undefined — a policy with nothing to measure did not score zero.',
  ],
  handler: async ({ id, bucket, limit }) => {
    const wanted = bucketsFor(bucket);

    const run = await labDb
      .selectFrom('eval_run')
      .select([
        'id',
        'label',
        'policy_id as policyId',
        'policy_label as policyLabel',
        'threshold',
        'batch',
        'status',
        'total',
        'scored',
        'errors',
        'tp',
        'fp',
        'tn',
        'fn',
        'note',
        'started_at as startedAt',
        'finished_at as finishedAt',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!run) error(404, `No run ${id}`);

    const [results, tally] = await Promise.all([
      labDb
        .selectFrom('eval_result as r')
        .innerJoin('sample as s', 's.id', 'r.sample_id')
        .select([
          'r.sample_id as sampleId',
          'r.score',
          'r.predicted',
          'r.expected',
          'r.bucket',
          'r.reason',
          'r.error',
          's.batch',
          's.positive_prompt as positivePrompt',
          's.negative_prompt as negativePrompt',
        ])
        .where('r.run_id', '=', id)
        .where('r.bucket', 'in', wanted)
        // Highest score first: within a bucket the most confident mistakes are the informative ones.
        // `nulls last` because score is null exactly when bucket = 'error'.
        .orderBy(sql`r.score desc nulls last`)
        .limit(limit + 1)
        .execute(),
      labDb
        .selectFrom('eval_result')
        .select(({ fn }) => ['bucket', fn.countAll<string>().as('n')])
        .where('run_id', '=', id)
        .groupBy('bucket')
        .execute(),
    ]);

    const bucketCounts: Record<string, number> = {};
    for (const t of tally) if (t.bucket) bucketCounts[t.bucket] = Number(t.n);

    return {
      run: {
        ...run,
        id: idOf(run.id),
        policyId: run.policyId === null ? null : idOf(run.policyId),
        precision: precisionOf(run),
        recall: recallOf(run),
      },
      bucketCounts,
      buckets: wanted,
      limit,
      truncated: results.length > limit,
      results: results.slice(0, limit).map((r) => ({ ...r, sampleId: idOf(r.sampleId) })),
    };
  },
});
