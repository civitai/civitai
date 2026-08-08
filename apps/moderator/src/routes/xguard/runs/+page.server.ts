import { sql } from '@civitai/db/kysely';
import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { getLabDb } from '$lib/server/xguard-lab';

// Evaluation run history, and the per-sample outcomes behind any one run.
//
// A run's four counters say whether a policy got better. They do not say why, and "why" is the only
// question worth opening this page for - so a selected run defaults to its FP and FN rows.

const BUCKETS = ['TP', 'FP', 'TN', 'FN', 'error'] as const;
type Bucket = (typeof BUCKETS)[number];

// Cap on rows rendered for one run. Big enough to read a whole bad bucket, small enough that a
// 5k-sample run does not ship 5k prompts to the browser.
const RESULT_LIMIT = 250;

function bucketsFor(filter: string): Bucket[] {
  if (filter === 'all') return [...BUCKETS];
  if (filter === 'wrong') return ['FP', 'FN'];
  return BUCKETS.includes(filter as Bucket) ? [filter as Bucket] : ['FP', 'FN'];
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);

  const label = url.searchParams.get('label');
  const runParam = url.searchParams.get('run');
  const bucketFilter = url.searchParams.get('bucket') ?? 'wrong';

  let runsQuery = getLabDb()
    .selectFrom('eval_run')
    .select([
      'id',
      'label',
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
      'precision',
      'recall',
      'f1',
      'note',
      'started_at as startedAt',
      'finished_at as finishedAt',
    ])
    .orderBy('started_at', 'desc')
    .limit(100);
  if (label) runsQuery = runsQuery.where('label', '=', label);

  const [runRows, labels] = await Promise.all([
    runsQuery.execute(),
    getLabDb().selectFrom('label_def').select(['name']).orderBy('name').execute(),
  ]);

  // @civitai/db registers a process-global INT8 parser, so bigint ids arrive as JS numbers even
  // though LabDB types them as strings. Normalise here or `id === searchParam` silently never matches.
  const runs = runRows.map((r) => ({ ...r, id: String(r.id) }));

  // Selecting nothing shows the newest run rather than an empty right-hand side, because the run
  // someone came to read is almost always the one they just finished. A `?run=` that is not in this
  // view - filtered out by `?label=`, or older than the 100-row window - falls back the same way and
  // says so, rather than rendering a blank pane that reads as broken.
  const requested = runParam ? runs.find((r) => r.id === runParam) ?? null : null;
  const selected = requested ?? runs[0] ?? null;
  const missingRun = runParam !== null && requested === null;

  const empty: Record<string, number> = {};
  if (!selected) {
    return {
      label,
      labels,
      runs,
      selected: null,
      missingRun,
      bucketFilter,
      results: [],
      bucketCounts: empty,
      truncated: false,
    };
  }

  const wanted = bucketsFor(bucketFilter);

  const [results, tally] = await Promise.all([
    getLabDb()
      .selectFrom('eval_result as r')
      .innerJoin('sample as s', 's.id', 'r.sample_id')
      .select([
        'r.id',
        'r.sample_id as sampleId',
        'r.score',
        'r.predicted',
        'r.expected',
        'r.bucket',
        'r.reason',
        'r.error',
        's.positive_prompt as positivePrompt',
        's.batch',
      ])
      .where('r.run_id', '=', selected.id)
      .where('r.bucket', 'in', wanted)
      // Highest score first: within a bucket, the most confident mistakes are the informative ones.
      // `nulls last` because score is null exactly when bucket = 'error', and Postgres would
      // otherwise sort those to the top and let them eat the row cap.
      .orderBy(sql`r.score desc nulls last`)
      .limit(RESULT_LIMIT + 1)
      .execute(),
    getLabDb()
      .selectFrom('eval_result')
      .select(({ fn }) => ['bucket', fn.countAll<string>().as('n')])
      .where('run_id', '=', selected.id)
      .groupBy('bucket')
      .execute(),
  ]);

  const bucketCounts: Record<string, number> = {};
  for (const t of tally) if (t.bucket) bucketCounts[t.bucket] = Number(t.n);

  // Every label's terms: a run list can span labels, and a prompt is worth highlighting for
  // vocabulary the label under test does not own.
  const terms = await getLabDb().selectFrom('label_term').select(['label', 'term', 'kind']).execute();

  return {
    label,
    labels,
    terms,
    runs,
    selected,
    missingRun,
    bucketFilter,
    results: results
      .slice(0, RESULT_LIMIT)
      .map((r) => ({ ...r, id: String(r.id), sampleId: String(r.sampleId) })),
    bucketCounts,
    truncated: results.length > RESULT_LIMIT,
  };
};
