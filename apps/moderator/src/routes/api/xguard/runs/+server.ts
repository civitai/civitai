import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getLabDb } from '$lib/server/xguard-lab';
import { precisionOf, recallOf } from '$lib/eval-metrics';
import { idOf, labConnectionString, orchestratorEnv } from '$lib/server/xguard-api';
import { runEvaluation } from '../../../../../xguard-lab/eval-core';

// Starting a run returns as soon as the `eval_run` row exists and lets the scan finish in the
// background. Inference over a few hundred prompts outlives any sane request timeout, and a caller
// that gets a 504 mid-run cannot tell a dead run from a slow one — so the run id is the receipt and
// `status` is the truth. A run that dies is written back as `status: 'error'`, never left on 'running'.

export const GET = defineWebhookEndpoint({
  summary: 'List evaluation runs, newest first.',
  input: z.object({
    label: z.string().trim().min(1).optional().describe('Restrict the list to one label.'),
    // Clamped rather than rejected, so a caller looping with a too-large page size still makes progress.
    limit: z.coerce
      .number()
      .int()
      .default(25)
      .transform((n) => Math.min(100, Math.max(1, n)))
      .describe('Runs to return, 1-100.'),
  }),
  returns: 'Each run with its counters and derived precision/recall.',
  notes: [
    'Precision and recall are derived, never read from the stored columns — early rows have a literal 0 there.',
  ],
  handler: async ({ label, limit }) => {
    let query = getLabDb()
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
    return {
      runs: runs.map((r) => ({
        ...r,
        id: idOf(r.id),
        policyId: r.policyId === null ? null : idOf(r.policyId),
        precision: precisionOf(r),
        recall: recallOf(r),
      })),
    };
  },
});

export const POST = defineWebhookEndpoint({
  summary: 'Start an evaluation run. Returns immediately with a run id to poll.',
  input: z.object({
    label: z.string().trim().min(1).max(120).describe('Label to evaluate.'),
    version: z.coerce
      .number()
      .int()
      .optional()
      .describe('Policy version. Omit to measure the live registry as a baseline.'),
    batch: z.string().trim().min(1).optional().describe('Restrict to one sampling batch.'),
    threshold: z.coerce
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Override the version's stored threshold."),
    note: z
      .string()
      .trim()
      .min(1)
      .default('started via API')
      .describe('Shows in run history. Say what you changed.'),
  }),
  returns:
    '202 with `runId` and `status: "running"`. Poll GET /api/xguard/runs/{id} until status is complete or error.',
  notes: [
    'A run needs confirmed ground truth. With none, this fails 400 rather than producing a run of n/a.',
  ],
  handler: async ({ label, version, batch, threshold, note }) => {
    let resolveRunId: (id: string) => void = () => {};
    const created = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });

    const run = runEvaluation({
      connectionString: labConnectionString(),
      label,
      policyVersion: version,
      batch,
      thresholdOverride: threshold,
      note,
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

    return json(
      { runId, label, status: 'running', poll: `/api/xguard/runs/${runId}` },
      { status: 202 }
    );
  },
});
