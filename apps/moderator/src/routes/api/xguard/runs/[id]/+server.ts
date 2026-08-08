import { error } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import type { RequestHandler } from './$types';
import { WebhookEndpoint } from '$lib/server/webhook-endpoint';
import { ok, intParam, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';
import { precisionOf, recallOf } from '$lib/eval-metrics';
import { idOf, requireId } from '$lib/server/xguard-api';

const BUCKETS = ['TP', 'FP', 'TN', 'FN', 'error'] as const;
type Bucket = (typeof BUCKETS)[number];

export const _doc: EndpointDoc = {
  summary: 'One evaluation run: its counters, and the per-sample rows behind them.',
  params: [
    { name: 'id', type: 'path', required: true, description: 'Run id from POST /api/xguard/runs.' },
    {
      name: 'bucket',
      type: '"wrong" | "all" | TP | FP | TN | FN | error',
      description: 'Which rows to return. Default "wrong" (FP + FN) — the ones worth reading.',
    },
    { name: 'limit', type: 'number', description: 'Default 100, max 1000.' },
  ],
  returns:
    'run (with derived precision/recall and `status`), bucketCounts, and the requested result rows with prompt text.',
  notes: [
    'Poll `status`: "running" until the scan finishes, then "complete" or "error". An errored run carries the reason in `note`.',
    'precision and recall are null, not 0, when undefined — a policy with nothing to measure did not score zero.',
  ],
};

function bucketsFor(filter: string | null): Bucket[] {
  if (filter === 'all') return [...BUCKETS];
  if (filter === null || filter === 'wrong') return ['FP', 'FN'];
  if ((BUCKETS as readonly string[]).includes(filter)) return [filter as Bucket];
  error(400, `bucket must be one of: wrong, all, ${BUCKETS.join(', ')}`);
}

export const GET: RequestHandler = WebhookEndpoint(async (event) => {
  const id = requireId(event.params.id);
  const limit = intParam(event.url, 'limit', 100, 1, 1000);
  const wanted = bucketsFor(event.url.searchParams.get('bucket'));

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

  return ok({
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
  });
});
