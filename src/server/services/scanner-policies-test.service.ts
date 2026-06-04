import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { XGuardModerationStep } from '@civitai/client';
import { getWorkflow } from '@civitai/client';
import pLimit from 'p-limit';
import { v4 as uuid } from 'uuid';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { SignalMessages } from '~/server/common/enums';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import type {
  ScannerPolicyCandidate,
  ScannerPolicyTestProgressData,
  TestCaseRow,
} from '~/server/schema/scanner-policies.schema';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import {
  appendResultsToWorkbook,
  categorizeFlip,
  parseInputWorkbook,
  pickBaselineCandidate,
  type ScoredResultRow,
} from '~/server/services/scanner-policies-xlsx.service';
import {
  clearRunCancelled,
  deleteRunState,
  getExportById,
  getRunState,
  getSystemPrompt,
  incrementRunCounter,
  isRunCancelled,
  listCandidates,
  readAllRunResults,
  recordRunResult,
  type ScannerPolicyRunState,
  setRunState,
  updateExportLastRun,
} from '~/server/services/scanner-policies.service';
import { signalClient } from '~/utils/signal-client';
import { getS3Client } from '~/utils/s3-utils';

/**
 * Scanner-policies test bench — scoring loop (submit-and-callback).
 *
 *   1. `startRun` mints a runId, stores the run state in sysRedis
 *      (candidates, rows, baseline, systemPrompt snapshot), and SUBMITS every
 *      (row × candidate) workflow with a callbackUrl pointing at
 *      `/api/webhooks/scanner-policy-result?...&runId=X&rowIdx=Y&candidateId=Z`.
 *      No `wait` — each submit returns as soon as the orchestrator accepts the
 *      workflow, so the outer request finishes in seconds even for 2,500-call
 *      runs.
 *   2. The orchestrator hits the webhook when each workflow finishes.
 *      `handleResultCallback` fetches the workflow, builds a ScoredResultRow,
 *      records it in sysRedis, and increments the counter.
 *   3. When the counter equals the expected total, `finalizeRun` is invoked
 *      to build the xlsx, upload it back to the dataset's S3 key, update the
 *      export record, emit the terminal signal, and clean up sysRedis state.
 *
 * For local development the callback URL must be reachable from the
 * orchestrator. Set `SCANNER_POLICY_CALLBACK_BASE=https://<your-tunnel>` in
 * `.env` and start the tunnel (e.g. `pnpm share`) before running tests.
 *
 * Cancellation: the webhook checks `isRunCancelled` and records an error row
 * for outstanding rows so the counter still advances to `total` and the run
 * finalizes cleanly.
 *
 * Discipline:
 *   - `submitAll` catches per-submit failures and turns them into immediate-
 *     error result rows so a single bad submit doesn't strand the whole run.
 *   - Every `signalClient.send` is wrapped in `.catch(...)`.
 *   - Finalization is single-shot per runId — the counter is monotonic and
 *     atomic, so exactly one caller observes the equality with `total`.
 */

const SUBMIT_CONCURRENCY = 8;
const PROGRESS_THROTTLE_MAX = 25;
const PROGRESS_TARGET_UPDATES = 20;

export type StartRunResult = {
  runId: string;
  datasetId: string;
  total: number;
  rowCount: number;
  candidateCount: number;
  baselineCandidateId: string | null;
};

/**
 * Construct the per-callback URL the orchestrator will hit when a workflow
 * finishes. Override the base via `SCANNER_POLICY_CALLBACK_BASE` (e.g. set it
 * to your ngrok / cloudflared URL for local dev). Defaults to `NEXTAUTH_URL` —
 * the public domain in prod; localhost in dev without a tunnel (orchestrator
 * can't reach that).
 */
function buildCallbackUrl(args: { runId: string; rowIdx: number; candidateId: string }): string {
  const base = process.env.SCANNER_POLICY_CALLBACK_BASE || env.NEXTAUTH_URL;
  const token = encodeURIComponent(env.WEBHOOK_TOKEN ?? '');
  const params = new URLSearchParams({
    token,
    runId: args.runId,
    rowIdx: String(args.rowIdx),
    candidateId: args.candidateId,
  });
  return `${base}/api/webhooks/scanner-policy-result?${params.toString()}`;
}

export async function startRun(args: {
  datasetId: string;
  userId: number;
}): Promise<StartRunResult> {
  const dataset = await getExportById(args.datasetId);
  if (!dataset) throw new Error(`Dataset ${args.datasetId} not found`);

  // Fetch the dataset workbook from S3 and parse rows.
  const s3 = getS3Client();
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: env.S3_UPLOAD_BUCKET, Key: dataset.s3Key })
  );
  const bytes = await streamToBuffer(obj.Body as NodeJS.ReadableStream);
  const parsed = await parseInputWorkbook(bytes);
  if (parsed.rows.length === 0) {
    throw new Error('Dataset workbook contains no test-case rows');
  }

  const candidates = await listCandidates({ mode: dataset.mode, label: dataset.label });
  const activeCandidates = candidates.filter((c) => c.active);
  if (activeCandidates.length === 0) {
    throw new Error(
      `No active candidates for ${dataset.mode}:${dataset.label}. Toggle at least one candidate active before running.`
    );
  }

  const runId = uuid();
  const total = parsed.rows.length * activeCandidates.length;
  const baseline = pickBaselineCandidate(activeCandidates);
  const systemPromptOverride = await getSystemPrompt(dataset.mode);
  const startedAt = new Date().toISOString();

  // Snapshot everything the webhook will need so it doesn't have to re-load
  // either the candidate list or the workbook on each callback.
  const state: ScannerPolicyRunState = {
    runId,
    userId: args.userId,
    datasetId: dataset.id,
    datasetS3Key: dataset.s3Key,
    mode: dataset.mode,
    label: dataset.label,
    total,
    baselineCandidateId: baseline?.id ?? null,
    systemPromptOverride,
    startedAt,
    candidates: activeCandidates.map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.mode,
      label: c.label,
      threshold: c.threshold,
      policyHash: c.policyHash,
      policy: c.policy,
    })),
    rows: parsed.rows.map((r) => ({
      contentHash: r.contentHash,
      expectedTrigger: r.expectedTrigger,
      positivePrompt: r.positivePrompt,
      negativePrompt: r.negativePrompt,
    })),
  };
  await setRunState(state);
  await clearRunCancelled(runId);
  await emitProgress(args.userId, {
    runId,
    phase: 'started',
    processed: 0,
    total,
  });

  // Fire-and-forget submit phase. Each submit only enqueues — the orchestrator
  // hits our webhook with the result later.
  void submitAll({
    runId,
    userId: args.userId,
    state,
  }).catch(async (err) => {
    await logToAxiom({
      name: 'scanner-policy-test',
      type: 'error',
      runId,
      datasetId: dataset.id,
      err: String(err),
      stack: (err as Error)?.stack,
    }).catch(() => undefined);
    await emitProgress(args.userId, {
      runId,
      phase: 'error',
      processed: 0,
      total,
      errorMessage: String(err),
    });
  });

  return {
    runId,
    datasetId: dataset.id,
    total,
    rowCount: parsed.rows.length,
    candidateCount: activeCandidates.length,
    baselineCandidateId: baseline?.id ?? null,
  };
}

async function submitAll(args: {
  runId: string;
  userId: number;
  state: ScannerPolicyRunState;
}): Promise<void> {
  const { runId, userId, state } = args;
  const limit = pLimit(SUBMIT_CONCURRENCY);
  const tasks: Promise<void>[] = [];

  for (let rowIdx = 0; rowIdx < state.rows.length; rowIdx++) {
    const row = state.rows[rowIdx];
    for (const candidate of state.candidates) {
      tasks.push(
        limit(async () => {
          try {
            const callbackUrl = buildCallbackUrl({
              runId,
              rowIdx,
              candidateId: candidate.id,
            });
            const common = {
              labels: [candidate.label],
              labelOverrides: [
                {
                  label: candidate.label,
                  action: 'Scan',
                  threshold: candidate.threshold,
                  policy: candidate.policy,
                },
              ],
              callbackUrl,
              recordForReview: false,
            };
            if (candidate.mode === 'prompt') {
              await createXGuardModerationRequest({
                mode: 'prompt',
                positivePrompt: row.positivePrompt,
                negativePrompt: row.negativePrompt,
                ...common,
              });
            } else {
              await createXGuardModerationRequest({
                mode: 'text',
                content: row.positivePrompt,
                ...common,
              });
            }
          } catch (err) {
            // A submit failure stops THIS row from ever calling back. Record
            // it as an error result directly so the counter still advances
            // and the run finalizes cleanly.
            await recordRunResult(
              runId,
              rowIdx,
              candidate.id,
              errorResultRow({
                runId,
                runAt: state.startedAt,
                row,
                candidate,
                message: (err as Error).message ?? String(err),
              })
            );
            await onResultRecorded({ runId, userId });
          }
        })
      );
    }
  }

  await Promise.all(tasks);
}

/**
 * Called from `/api/webhooks/scanner-policy-result` for each completed
 * workflow. Fetches the workflow, builds a result row, records it, then
 * triggers finalization if this was the last expected result.
 */
export async function handleResultCallback(args: {
  runId: string;
  rowIdx: number;
  candidateId: string;
  workflowId: string;
  status: string;
}): Promise<void> {
  const state = await getRunState(args.runId);
  if (!state) {
    // Run state expired or was cleaned up — orchestrator delivered a stale
    // callback. Log + drop.
    await logToAxiom({
      name: 'scanner-policy-result',
      type: 'warning',
      message: 'callback for unknown runId',
      runId: args.runId,
      workflowId: args.workflowId,
    }).catch(() => undefined);
    return;
  }

  const row = state.rows[args.rowIdx];
  const candidate = state.candidates.find((c) => c.id === args.candidateId);
  if (!row || !candidate) {
    await logToAxiom({
      name: 'scanner-policy-result',
      type: 'warning',
      message: 'callback row/candidate not found in run state',
      runId: args.runId,
      rowIdx: args.rowIdx,
      candidateId: args.candidateId,
    }).catch(() => undefined);
    return;
  }

  const cancelled = await isRunCancelled(args.runId);
  let result: ScoredResultRow;

  if (cancelled) {
    result = errorResultRow({
      runId: args.runId,
      runAt: state.startedAt,
      row,
      candidate,
      message: 'run cancelled before result arrived',
      workflowId: args.workflowId,
    });
  } else if (args.status !== 'succeeded') {
    result = errorResultRow({
      runId: args.runId,
      runAt: state.startedAt,
      row,
      candidate,
      message: `workflow status: ${args.status}`,
      workflowId: args.workflowId,
    });
  } else {
    result = await fetchAndScore({
      runId: args.runId,
      runAt: state.startedAt,
      row,
      candidate,
      workflowId: args.workflowId,
    });
  }

  await recordRunResult(args.runId, args.rowIdx, args.candidateId, result);
  await onResultRecorded({ runId: args.runId, userId: state.userId });
}

async function onResultRecorded(args: { runId: string; userId: number }): Promise<void> {
  const state = await getRunState(args.runId);
  if (!state) return;

  const processed = await incrementRunCounter(args.runId);

  // Scale the throttle to the dataset size so a 40-cell smoke test still gets
  // visible updates (~every 2 results) while a 2,500-cell production run
  // doesn't spam the signal hub.
  const throttleEvery = Math.max(
    1,
    Math.min(PROGRESS_THROTTLE_MAX, Math.ceil(state.total / PROGRESS_TARGET_UPDATES))
  );
  if (processed % throttleEvery === 0 || processed === state.total) {
    await emitProgress(args.userId, {
      runId: args.runId,
      phase: 'progress',
      processed,
      total: state.total,
    });
  }

  if (processed >= state.total) {
    // Only the callback that brings us to `total` finalizes — the counter is
    // monotonic and incrementRunCounter is atomic, so exactly one caller hits
    // the equality.
    await finalizeRun(args.runId);
  }
}

async function finalizeRun(runId: string): Promise<void> {
  const state = await getRunState(runId);
  if (!state) return;

  // Read every recorded result and slot it into a row-major array we can
  // later traverse to compute baseline-relative verdict categories.
  const allResultsByKey = await readAllRunResults<ScoredResultRow>(runId);
  const allResults: ScoredResultRow[] = new Array(state.total);
  const candidateIdToIdx = new Map(state.candidates.map((c, i) => [c.id, i]));

  for (const [key, value] of Object.entries(allResultsByKey)) {
    const [rowIdxStr, candidateId] = key.split(':');
    const rowIdx = Number(rowIdxStr);
    const candIdx = candidateIdToIdx.get(candidateId);
    if (rowIdx >= 0 && candIdx !== undefined) {
      allResults[rowIdx * state.candidates.length + candIdx] = value;
    }
  }

  // Compute verdictCategory against the baseline candidate's result for the same row.
  if (state.baselineCandidateId) {
    const baselineIdx = candidateIdToIdx.get(state.baselineCandidateId);
    if (baselineIdx !== undefined) {
      for (let rowIdx = 0; rowIdx < state.rows.length; rowIdx++) {
        const baselineSlot = rowIdx * state.candidates.length + baselineIdx;
        const baselineRow = allResults[baselineSlot] ?? null;
        const baselineTriggered = baselineRow?.triggered ?? null;
        for (let c = 0; c < state.candidates.length; c++) {
          const slot = rowIdx * state.candidates.length + c;
          const row = allResults[slot];
          if (!row) continue;
          if (row.candidateId === state.baselineCandidateId) continue;
          row.verdictCategory = categorizeFlip({
            expectedTrigger: row.expectedTrigger,
            candidateTriggered: row.triggered,
            baselineTriggered,
          });
        }
      }
    }
  }

  const filledResults = allResults.filter(Boolean);

  // Compute the set of policyHashes that have since been archived. Their
  // existing data in the workbook gets pruned during the merge so the workbook
  // stays focused on policies the moderator still considers in play.
  const currentCandidates = await listCandidates({ mode: state.mode, label: state.label });
  const archivedPolicyHashes = new Set(
    currentCandidates.filter((c) => c.archived).map((c) => c.policyHash)
  );

  // Pull the workbook from S3, append/merge the Results sheet, write back.
  const s3 = getS3Client();
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: env.S3_UPLOAD_BUCKET, Key: state.datasetS3Key })
  );
  const bytes = await streamToBuffer(obj.Body as NodeJS.ReadableStream);
  const parsed = await parseInputWorkbook(bytes);
  const outBuffer = await appendResultsToWorkbook(
    parsed.workbook,
    filledResults,
    archivedPolicyHashes
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_UPLOAD_BUCKET,
      Key: state.datasetS3Key,
      Body: outBuffer,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  );

  await updateExportLastRun({
    mode: state.mode,
    label: state.label,
    exportId: state.datasetId,
    lastRunId: runId,
    lastRunAt: new Date().toISOString(),
    lastRunBy: state.userId,
    lastRunCandidateIds: state.candidates.map((c) => c.id),
  });

  const cancelled = await isRunCancelled(runId);
  await emitProgress(state.userId, {
    runId,
    phase: cancelled ? 'cancelled' : 'done',
    processed: state.total,
    total: state.total,
    exportId: state.datasetId,
  });

  await clearRunCancelled(runId);
  await deleteRunState(runId);
}

/** Build a ScoredResultRow from an already-resolved workflow object. Used by
 *  both the webhook (after a getWorkflow round-trip) and the dev inline path
 *  (which already has the workflow data from the `wait: 60` response). */
function scoreFromWorkflow(args: {
  runId: string;
  runAt: string;
  row: ScannerPolicyRunState['rows'][number];
  candidate: ScannerPolicyRunState['candidates'][number];
  workflow: unknown;
  workflowId: string | null;
}): ScoredResultRow {
  const { row, candidate, runId, runAt, workflow, workflowId } = args;
  const base = {
    contentHash: row.contentHash,
    candidateId: candidate.id,
    candidateName: candidate.name,
    candidateMode: candidate.mode,
    candidateLabel: candidate.label,
    candidateThreshold: candidate.threshold,
    candidatePolicy: candidate.policy,
    policyHash: candidate.policyHash,
    expectedTrigger: row.expectedTrigger,
    runId,
    runAt,
    workflowId,
  };

  if (!workflow) {
    return {
      ...base,
      score: null,
      triggered: null,
      correct: null,
      verdictCategory: 'error',
      errorMessage: 'workflow result missing',
    };
  }
  const steps = ((workflow as { steps?: unknown[] }).steps ?? []) as XGuardModerationStep[];
  const xguardStep = steps.find((s) => s.$type === 'xGuardModeration');
  // Orchestrator shape: `output.results: [{ label, score, triggered, ... }]` —
  // an array, not a label-keyed record. Match by label case-insensitively
  // because the registry uses PascalCase but some pipelines / overrides have
  // used lowercase historically.
  const output = xguardStep?.output as
    | { results?: Array<{ label?: string; score?: number; triggered?: boolean }> }
    | undefined;
  const target = candidate.label.toLowerCase();
  const labelOut = output?.results?.find(
    (r) => typeof r.label === 'string' && r.label.toLowerCase() === target
  );
  if (!labelOut) {
    const seenLabels = output?.results?.map((r) => r.label).filter(Boolean) ?? [];
    return {
      ...base,
      score: null,
      triggered: null,
      correct: null,
      verdictCategory: 'error',
      errorMessage: `no result for label "${candidate.label}" in xGuardModeration output (got: ${
        seenLabels.length > 0 ? seenLabels.join(', ') : 'no results'
      })`,
    };
  }
  const score = typeof labelOut.score === 'number' ? labelOut.score : null;
  const triggered = score !== null ? score >= candidate.threshold : null;
  const correct = triggered === null ? null : triggered === row.expectedTrigger;
  return {
    ...base,
    score,
    triggered,
    correct,
    verdictCategory:
      triggered === null
        ? 'error'
        : triggered === row.expectedTrigger
        ? row.expectedTrigger
          ? 'agree-trigger'
          : 'agree-secure'
        : 'no-baseline', // overwritten in finalize() once baseline is known
  };
}

async function fetchAndScore(args: {
  runId: string;
  runAt: string;
  row: ScannerPolicyRunState['rows'][number];
  candidate: ScannerPolicyRunState['candidates'][number];
  workflowId: string;
}): Promise<ScoredResultRow> {
  try {
    const { data } = await getWorkflow({
      client: internalOrchestratorClient,
      path: { workflowId: args.workflowId },
    });
    return scoreFromWorkflow({ ...args, workflow: data, workflowId: args.workflowId });
  } catch (err) {
    return {
      contentHash: args.row.contentHash,
      candidateId: args.candidate.id,
      candidateName: args.candidate.name,
      candidateMode: args.candidate.mode,
      candidateLabel: args.candidate.label,
      candidateThreshold: args.candidate.threshold,
      candidatePolicy: args.candidate.policy,
      policyHash: args.candidate.policyHash,
      expectedTrigger: args.row.expectedTrigger,
      runId: args.runId,
      runAt: args.runAt,
      workflowId: args.workflowId,
      score: null,
      triggered: null,
      correct: null,
      verdictCategory: 'error',
      errorMessage: (err as Error).message ?? String(err),
    };
  }
}

function errorResultRow(args: {
  runId: string;
  runAt: string;
  row: ScannerPolicyRunState['rows'][number];
  candidate: ScannerPolicyRunState['candidates'][number];
  message: string;
  workflowId?: string | null;
}): ScoredResultRow {
  return {
    contentHash: args.row.contentHash,
    candidateId: args.candidate.id,
    candidateName: args.candidate.name,
    candidateMode: args.candidate.mode,
    candidateLabel: args.candidate.label,
    candidateThreshold: args.candidate.threshold,
    candidatePolicy: args.candidate.policy,
    policyHash: args.candidate.policyHash,
    expectedTrigger: args.row.expectedTrigger,
    runId: args.runId,
    runAt: args.runAt,
    workflowId: args.workflowId ?? null,
    score: null,
    triggered: null,
    correct: null,
    verdictCategory: 'error',
    errorMessage: args.message,
  };
}

async function emitProgress(userId: number, data: ScannerPolicyTestProgressData): Promise<void> {
  try {
    await signalClient.send({
      userId,
      target: SignalMessages.ScannerPolicyTestProgress,
      data,
    });
  } catch (err) {
    await logToAxiom({
      name: 'scanner-policy-signal',
      type: 'warning',
      userId,
      runId: data.runId,
      err: String(err),
    }).catch(() => undefined);
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
