import { updateWorkflow as clientUpdateWorkflow } from '@civitai/orchestration-client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

const PENDING_STATUSES = new Set(['unassigned', 'preparing', 'scheduled', 'processing']);
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const CANCEL_ATTEMPTS = 2;
/** The caller's wait. Cancels still running past it finish in the background. */
export const CANCEL_PENDING_DEADLINE_MS = 5_000;

function log(name: string, fields: Record<string, unknown>) {
  Promise.resolve()
    .then(() => logToAxiom({ name, type: 'error', ...fields }))
    .catch(() => undefined);
}

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
  // The token the orchestrator already accepts for this account, never a new one: a key minted now
  // would be checked against the restricted standing and refused. Server-side only.
  const token = await getOrchestratorToken(userId, undefined, {
    allowRestricted: true,
    existingOnly: true,
  });
  const fromDate = new Date(Date.now() - LOOKBACK_MS);
  const cancels: Promise<void>[] = [];
  let cursor: string | undefined;
  let pages = 0;
  try {
    for (; pages < MAX_PAGES; pages++) {
      // `hideMatureContent: false`: a pending mature workflow must be listed too.
      const { items, nextCursor } = await queryWorkflows({
        token,
        take: PAGE_SIZE,
        cursor,
        tags: [],
        fromDate,
        hideMatureContent: false,
      });
      // Cancelled page by page, so a later page failing loses only what it held.
      for (const workflow of items)
        if (workflow.id && PENDING_STATUSES.has(workflow.status ?? ''))
          cancels.push(cancelOne(token, userId, workflow.id));
      if (!nextCursor || !items.length) break;
      cursor = nextCursor;
    }
    if (pages === MAX_PAGES) log('mute.cancel-workflows-list-truncated', { userId, pages });
  } finally {
    await Promise.all(cancels);
  }
}

/**
 * Cancels the account's pending generations. For a mute: it must run before the account's
 * orchestrator tokens are revoked, since a restricted identity can neither list nor cancel after.
 * Never throws, and waits at most `CANCEL_PENDING_DEADLINE_MS`.
 */
export async function cancelPendingWorkflows(userId: number): Promise<void> {
  const work = cancelAll(userId).catch((error) =>
    log('mute.cancel-workflows-list-failed', { userId, error: safeError(error) })
  );
  await withTimeoutFallback(work, CANCEL_PENDING_DEADLINE_MS, undefined);
}
