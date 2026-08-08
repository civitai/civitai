import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireXguardToken, ok, readJson, intParam, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';
import { precisionOf, recallOf } from '$lib/eval-metrics';
import { idOf, labConnectionString, orchestratorEnv, requireName } from '$lib/server/xguard-api';
import { runEvaluation } from '../../../../../xguard-lab/eval-core';

// Starting a run returns as soon as the `eval_run` row exists and lets the scan finish in the
// background. Inference over a few hundred prompts outlives any sane request timeout, and a caller
// that gets a 504 mid-run cannot tell a dead run from a slow one — so the run id is the receipt and
// `status` is the truth. A run that dies is written back as `status: 'error'`, never left on 'running'.

export const _doc: EndpointDoc = {
  summary:
    'List evaluation runs, or start one. Starting returns immediately with a run id to poll.',
  params: [
    { name: 'label', type: 'string', description: 'GET: restrict the list to one label.' },
    { name: 'limit', type: 'number', description: 'GET: default 25, max 100.' },
    {
      name: 'label',
      type: 'string (POST body)',
      required: true,
      description: 'Label to evaluate.',
    },
    {
      name: 'version',
      type: 'number (POST body)',
      description: 'Policy version. Omit to measure the live registry as a baseline.',
    },
    { name: 'batch', type: 'string (POST body)', description: 'Restrict to one sampling batch.' },
    {
      name: 'threshold',
      type: 'number (POST body)',
      description: "Override the version's stored threshold.",
    },
    {
      name: 'note',
      type: 'string (POST body)',
      description: 'Shows in run history. Say what you changed.',
    },
  ],
  returns:
    'POST returns 202 with `runId` and `status: "running"`. Poll GET /api/xguard/runs/{id} until status is complete or error.',
  notes: [
    'Precision and recall are derived, never read from the stored columns — early rows have a literal 0 there.',
    'A run needs confirmed ground truth. With none, POST fails 400 rather than producing a run of n/a.',
  ],
};

export const GET: RequestHandler = async (event) => {
  requireXguardToken(event.request);
  const label = event.url.searchParams.get('label');
  const limit = intParam(event.url, 'limit', 25, 1, 100);

  let query = labDb
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
    .orderBy('started_at', 'desc')
    .limit(limit);
  if (label) query = query.where('label', '=', label);

  const runs = await query.execute();
  return ok({
    runs: runs.map((r) => ({
      ...r,
      id: idOf(r.id),
      policyId: r.policyId === null ? null : idOf(r.policyId),
      precision: precisionOf(r),
      recall: recallOf(r),
    })),
  });
};

export const POST: RequestHandler = async (event) => {
  requireXguardToken(event.request);
  const body = await readJson<Record<string, unknown>>(event);

  const label = requireName(body.label, 'label');
  const version =
    body.version === undefined || body.version === null ? undefined : Number(body.version);
  if (version !== undefined && !Number.isFinite(version)) error(400, 'version must be a number');
  const threshold =
    body.threshold === undefined || body.threshold === null ? undefined : Number(body.threshold);
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    error(400, 'threshold must be between 0 and 1');
  }

  let resolveRunId: (id: string) => void = () => {};
  const created = new Promise<string>((resolve) => {
    resolveRunId = resolve;
  });

  const run = runEvaluation({
    connectionString: labConnectionString(),
    label,
    policyVersion: version,
    batch: typeof body.batch === 'string' && body.batch.trim() ? body.batch.trim() : undefined,
    thresholdOverride: threshold,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : 'started via API',
    orchestrator: orchestratorEnv(),
    onRunCreated: resolveRunId,
  });
  // The failure is recorded on the run row; this only stops an unhandled rejection taking the process
  // down once the request has already returned.
  run.catch(() => {});

  let runId: string;
  try {
    // Whichever comes first: the row exists (normal), or the whole thing failed before creating one
    // (no ground truth, no such policy version) — which must be a synchronous 400, not a phantom run.
    runId = await Promise.race([created, run.then((summary) => summary.runId)]);
  } catch (err) {
    error(400, (err as Error).message);
  }

  return ok({ runId, label, status: 'running', poll: `/api/xguard/runs/${runId}` }, 202);
};
