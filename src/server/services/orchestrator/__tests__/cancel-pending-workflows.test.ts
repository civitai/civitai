import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const updateWorkflow = vi.hoisted(() =>
  vi.fn(async (_args: { path: { workflowId: string } }) => ({ error: undefined as unknown }))
);
const queryWorkflows = vi.hoisted(() =>
  vi.fn(
    async (_args: { cursor?: string }) =>
      ({ items: [], nextCursor: undefined } as {
        items: { id: string; status: string }[];
        nextCursor?: string;
      })
  )
);
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  updateWorkflow,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({ queryWorkflows }));
const getOrchestratorToken = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'user-token'));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken }));

const { cancelPendingWorkflows, CANCEL_PENDING_DEADLINE_MS } = await import(
  '~/server/services/orchestrator/cancel-pending-workflows'
);
const { createCivitaiClient } = await import('@civitai/orchestration-client');

const cancelled = () => updateWorkflow.mock.calls.map(([args]) => args.path.workflowId);
const loggedNames = () =>
  loggingMock.logToAxiom.mock.calls.map(([entry]) => (entry as { name: string }).name);
const failures = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([entry]) => entry as { name: string; workflowId?: string })
    .filter((entry) => entry.name === 'mute.cancel-workflow-failed');

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [getOrchestratorToken, queryWorkflows, updateWorkflow]) mock.mockReset();
  getOrchestratorToken.mockResolvedValue('user-token');
  queryWorkflows.mockResolvedValue({ items: [], nextCursor: undefined });
  updateWorkflow.mockImplementation(async () => ({ error: undefined }));
});

describe('cancelPendingWorkflows', () => {
  it('cancels only the pending workflows, across pages', async () => {
    queryWorkflows
      .mockResolvedValueOnce({
        items: [
          { id: 'w-queued', status: 'unassigned' },
          { id: 'w-done', status: 'succeeded' },
          { id: 'w-running', status: 'processing' },
        ],
        nextCursor: 'c1',
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'w-prep', status: 'preparing' },
          { id: 'w-old', status: 'canceled' },
        ],
        nextCursor: undefined,
      });
    await cancelPendingWorkflows(42);
    expect(cancelled().sort()).toEqual(['w-prep', 'w-queued', 'w-running']);
    expect(queryWorkflows.mock.calls[1][0].cursor).toBe('c1');
    // The account's existing token, never a fresh mint, and it is what the cancels carry.
    expect(getOrchestratorToken).toHaveBeenCalledWith(42, undefined, {
      allowRestricted: true,
      existingOnly: true,
    });
    expect(createCivitaiClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'user-token' })
    );
  });

  it('stops listing at five pages and says so', async () => {
    let page = 0;
    queryWorkflows.mockImplementation(async () => {
      if (++page > 10) throw new Error('unbounded paging');
      return { items: [{ id: `w-${page}`, status: 'processing' }], nextCursor: `c${page}` };
    });
    await cancelPendingWorkflows(42);
    expect(queryWorkflows).toHaveBeenCalledTimes(5);
    expect(cancelled()).toHaveLength(5);
    expect(loggedNames()).toContain('mute.cancel-workflows-list-truncated');
  });

  it('still cancels the first page when a later page fails', async () => {
    queryWorkflows
      .mockResolvedValueOnce({ items: [{ id: 'w-1', status: 'processing' }], nextCursor: 'c1' })
      .mockRejectedValueOnce(new Error('orchestrator down'));
    await cancelPendingWorkflows(42);
    expect(cancelled()).toEqual(['w-1']);
    expect(loggedNames()).toContain('mute.cancel-workflows-list-failed');
  });

  it('returns after the deadline when the orchestrator hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      queryWorkflows.mockImplementation(() => new Promise(() => undefined));
      let settled = false;
      const done = cancelPendingWorkflows(42).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(CANCEL_PENDING_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels nothing when no token is cached', async () => {
    getOrchestratorToken.mockRejectedValueOnce(new Error('No generation token is cached'));
    await expect(cancelPendingWorkflows(42)).resolves.toBeUndefined();
    expect(queryWorkflows).not.toHaveBeenCalled();
  });

  it('retries a failed cancel once, then logs the workflow id', async () => {
    queryWorkflows.mockResolvedValueOnce({
      items: [
        { id: 'w-flaky', status: 'processing' },
        { id: 'w-stuck', status: 'scheduled' },
      ],
    });
    // w-flaky fails once then succeeds; w-stuck fails every time.
    const seen = new Map<string, number>();
    updateWorkflow.mockImplementation(async ({ path }) => {
      const n = (seen.get(path.workflowId) ?? 0) + 1;
      seen.set(path.workflowId, n);
      const fails = path.workflowId === 'w-stuck' || n === 1;
      return { error: fails ? { status: 503 } : undefined };
    });
    await cancelPendingWorkflows(42);
    expect(cancelled().filter((id) => id === 'w-flaky')).toHaveLength(2);
    expect(cancelled().filter((id) => id === 'w-stuck')).toHaveLength(2);
    expect(failures().map((f) => f.workflowId)).toEqual(['w-stuck']);
  });

  it('never throws when the list fails', async () => {
    queryWorkflows.mockRejectedValueOnce(new Error('orchestrator down'));
    await expect(cancelPendingWorkflows(42)).resolves.toBeUndefined();
    expect(updateWorkflow).not.toHaveBeenCalled();
  });
});
