import { updateWorkflow as clientUpdateWorkflow } from '@civitai/orchestration-client';
import pLimit from 'p-limit';
import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';

const PENDING_STATUSES = new Set(['unassigned', 'preparing', 'scheduled', 'processing']);
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const CANCEL_ATTEMPTS = 2;
const CANCEL_CONCURRENCY = 10;
/** The caller's wait. Cancels still running past it finish in the background. */
export const CANCEL_PENDING_DEADLINE_MS = 5_000;

type ListedWorkflow = { id?: string; status?: string; tags?: string[] };

function log(name: string, fields: Record<string, unknown>) {
  Promise.resolve()
    .then(() => logToAxiom({ name, type: 'error', ...fields }))
    .catch(() => undefined);
}

/** The account's site generations, newest first. */
async function listGenerations(token: string, userId: number, fromDate: Date, cursor?: string) {
  const query = new URLSearchParams({
    userId: String(userId),
    take: String(PAGE_SIZE),
    tags: WORKFLOW_TAGS.GENERATION,
    fromDate: fromDate.toISOString(),
  });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`${env.ORCHESTRATOR_ENDPOINT}/v1/manager/workflows?${query}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(CANCEL_PENDING_DEADLINE_MS),
  });
  if (!response.ok) throw new Error(`Orchestrator answered ${response.status}`);
  const body = (await response.json()) as { next?: string | null; items?: ListedWorkflow[] };
  return { items: Array.isArray(body.items) ? body.items : [], next: body.next ?? undefined };
}

const isCancellable = (workflow: ListedWorkflow): workflow is ListedWorkflow & { id: string } =>
  !!workflow.id &&
  PENDING_STATUSES.has((workflow.status ?? '').toLowerCase()) &&
  (workflow.tags ?? []).includes(WORKFLOW_TAGS.GENERATION) &&
  // App Block runs carry the generation tag too; trainings do not.
  !(workflow.tags ?? []).includes(WORKFLOW_TAGS.APP_BLOCK);

async function cancelOne(token: string, userId: number, workflowId: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt++) {
    try {
      // The generated client resolves on an HTTP error, so `error` is the failure signal.
      const { error } = await clientUpdateWorkflow({
        client: createOrchestratorClient(token),
        path: { workflowId },
        body: { status: 'canceled' },
      });
      if (!error) return;
      lastError = error;
    } catch (thrown) {
      lastError = thrown;
    }
  }
  log('mute.cancel-workflow-failed', { userId, workflowId, error: safeError(lastError) });
}

async function cancelAll(userId: number) {
  // The service credential, which may list and cancel any account's workflows.
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!env.ORCHESTRATOR_ENDPOINT || !token) throw new Error('The orchestrator is not configured');
  const fromDate = new Date(Date.now() - LOOKBACK_MS);
  const limit = pLimit(CANCEL_CONCURRENCY);
  const cancels: Promise<void>[] = [];
  let cursor: string | undefined;
  let pages = 0;
  try {
    for (; pages < MAX_PAGES; pages++) {
      const { items, next } = await listGenerations(token, userId, fromDate, cursor);
      // Cancelled page by page, so a later page failing loses only what it held.
      for (const workflow of items)
        if (isCancellable(workflow))
          cancels.push(limit(() => cancelOne(token, userId, workflow.id)));
      if (!next || !items.length) break;
      cursor = next;
    }
    if (pages === MAX_PAGES) log('mute.cancel-workflows-list-truncated', { userId, pages });
  } finally {
    await Promise.all(cancels);
  }
}

/**
 * Cancels the account's pending site generations; never a training or an App Block run. Jobs
 * already running may still complete. Never throws, and waits at most `CANCEL_PENDING_DEADLINE_MS`.
 */
export async function cancelPendingWorkflows(userId: number): Promise<void> {
  const work = cancelAll(userId).catch((error) =>
    log('mute.cancel-workflows-list-failed', { userId, error: safeError(error) })
  );
  await withTimeoutFallback(work, CANCEL_PENDING_DEADLINE_MS, undefined);
}
