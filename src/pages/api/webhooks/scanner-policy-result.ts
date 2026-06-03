/**
 * Scanner-policy test-run result webhook.
 *
 * Called by the orchestrator after each test-run workflow finishes. Each row
 * × candidate of a run is submitted with a callbackUrl that includes the
 * runId / rowIdx / candidateId on the query string, so this handler knows
 * exactly which slot in the run a callback belongs to without having to
 * resolve it from workflow metadata.
 *
 * Request:
 *   POST /api/webhooks/scanner-policy-result
 *     ?token=<WEBHOOK_TOKEN>&runId=<uuid>&rowIdx=<int>&candidateId=<uuid>
 *   Body: WorkflowEvent { workflowId, status }
 *
 * On `succeeded` we hand off to handleResultCallback, which fetches the
 * workflow, extracts the xGuardModeration step output, scores the candidate
 * against the row's expected verdict, and records the result. Non-succeeded
 * statuses are recorded as error rows so the run still finalizes cleanly.
 *
 * Idempotency: re-delivered callbacks for the same (runId, rowIdx, candidateId)
 * will overwrite the existing hash field with the same value AND will increment
 * the counter again, which would otherwise corrupt the finalize trigger. We
 * guard against that by no-op-ing if the field is already present.
 */
import type { WorkflowEvent } from '@civitai/client';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis, REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '~/server/redis/client';
import { handleResultCallback } from '~/server/services/scanner-policies-test.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const RESULTS_KEY = REDIS_SYS_KEYS.SCANNER_POLICY.RUN_RESULTS;

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const runId = pickQuery(req.query.runId);
  const rowIdxStr = pickQuery(req.query.rowIdx);
  const candidateId = pickQuery(req.query.candidateId);
  if (!runId || rowIdxStr === undefined || !candidateId) {
    return res.status(400).json({ error: 'Missing runId / rowIdx / candidateId' });
  }
  const rowIdx = Number(rowIdxStr);
  if (!Number.isFinite(rowIdx) || rowIdx < 0) {
    return res.status(400).json({ error: 'Invalid rowIdx' });
  }

  // Idempotency guard: if the (rowIdx, candidateId) field already exists in
  // the run-results hash, this is a redelivered callback — return 200 without
  // incrementing the counter again.
  const resultsKey = `${RESULTS_KEY}:${runId}` as RedisKeyTemplateSys;
  const field = `${rowIdx}:${candidateId}`;
  const exists = await sysRedis.hExists(resultsKey, field).catch(() => false);
  if (exists) {
    return res.status(200).json({ ok: true, deduped: true });
  }

  try {
    const event = req.body as WorkflowEvent;
    if (!event?.workflowId || !event?.status) {
      return res.status(400).json({ error: 'Malformed WorkflowEvent body' });
    }

    await handleResultCallback({
      runId,
      rowIdx,
      candidateId,
      workflowId: event.workflowId,
      status: String(event.status),
    });
    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    const error = e as Error;
    await logToAxiom({
      name: 'scanner-policy-result',
      type: 'error',
      message: error.message,
      stack: error.stack,
      runId,
      rowIdx,
      candidateId,
    }).catch(() => undefined);
    return res.status(500).json({ error: error.message });
  }
});

function pickQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
