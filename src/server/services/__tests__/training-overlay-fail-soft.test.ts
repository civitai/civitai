import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * The training list is where a user goes to find out what happened to a run, so the overlay is
 * strictly additive: when the orchestrator cannot answer, the page must still render from the
 * stored copy. Every failure below has to come back as an empty overlay, because
 * `applyTrainingWorkflowOverlay` treats that as "change nothing".
 */

const { mockQueryWorkflows, mockGetToken, mockGetWorkflow } = vi.hoisted(() => ({
  mockQueryWorkflows: vi.fn(),
  mockGetToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  queryWorkflows: mockQueryWorkflows,
  getWorkflow: mockGetWorkflow,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  getOrchestratorToken: mockGetToken,
}));
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { getTrainingWorkflowOverlay } from '~/server/services/orchestrator/training/training-state';

const ctx = { req: {}, res: {} } as never;

function trainingWorkflow(modelFileId: number) {
  return {
    id: `wf-${modelFileId}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'succeeded',
    steps: [
      {
        $type: 'imageResourceTraining',
        metadata: { modelFileId },
        startedAt: '2026-08-01T00:00:00.000Z',
        completedAt: '2026-08-01T01:00:00.000Z',
        output: { epochs: [], sampleImagesPrompts: [] },
      },
    ],
  };
}

describe('getTrainingWorkflowOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue('token');
  });

  it('keys live state by the modelFileId the workflow step carries', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [trainingWorkflow(11), trainingWorkflow(22)] });

    const overlay = await getTrainingWorkflowOverlay({ userId: 1, ctx });

    expect([...overlay.byModelFileId.keys()]).toEqual([11, 22]);
    expect(overlay.truncated).toBe(false);
  });

  it('queries only the training tag, and only the retention window', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [] });

    await getTrainingWorkflowOverlay({ userId: 1, ctx });

    const [args] = mockQueryWorkflows.mock.calls[0];
    expect(args.tags).toEqual(['training']);
    const windowDays = (Date.now() - args.fromDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(windowDays).toBeGreaterThan(29.9);
    expect(windowDays).toBeLessThan(30.1);
  });

  it('returns an empty overlay when the orchestrator query fails, and says so', async () => {
    mockQueryWorkflows.mockRejectedValue(new Error('orchestrator unavailable'));

    const overlay = await getTrainingWorkflowOverlay({ userId: 1, ctx });

    expect(overlay.byModelFileId.size).toBe(0);
    // Degrading to the stored copy is invisible in the UI, so the log is the only signal it happened.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'training-overlay', type: 'warning' }),
      'webhooks'
    );
  });

  it('returns an empty overlay when the token cannot be minted', async () => {
    mockGetToken.mockRejectedValue(new Error('redis down'));

    const overlay = await getTrainingWorkflowOverlay({ userId: 1, ctx });

    expect(overlay.byModelFileId.size).toBe(0);
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  it('skips a malformed workflow rather than losing the whole overlay', async () => {
    mockQueryWorkflows.mockResolvedValue({
      items: [
        { id: 'wf-bad', createdAt: '2026-08-01T00:00:00.000Z', status: 'succeeded', steps: [] },
        trainingWorkflow(33),
      ],
    });

    const overlay = await getTrainingWorkflowOverlay({ userId: 1, ctx });

    expect([...overlay.byModelFileId.keys()]).toEqual([33]);
  });

  it('goes back for a page row the bulk query did not cover', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [trainingWorkflow(1)] });
    mockGetWorkflow.mockResolvedValue(trainingWorkflow(500));

    const overlay = await getTrainingWorkflowOverlay({
      userId: 1,
      ctx,
      refs: [{ modelFileId: 500, workflowId: 'wf-500' }],
    });

    expect(mockGetWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ path: { workflowId: 'wf-500' } })
    );
    expect([...overlay.byModelFileId.keys()].sort((a, b) => a - b)).toEqual([1, 500]);
    expect(overlay.truncated).toBe(false);
  });

  it('does not re-fetch a row the bulk query already covered', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [trainingWorkflow(1)] });

    await getTrainingWorkflowOverlay({
      userId: 1,
      ctx,
      refs: [{ modelFileId: 1, workflowId: 'wf-1' }],
    });

    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it('caps the backfill and says what it left on stored state', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [] });
    mockGetWorkflow.mockResolvedValue(trainingWorkflow(1));
    const refs = Array.from({ length: 40 }, (_, i) => ({
      modelFileId: i + 1,
      workflowId: `wf-${i + 1}`,
    }));

    const overlay = await getTrainingWorkflowOverlay({ userId: 1, ctx, refs });

    expect(mockGetWorkflow).toHaveBeenCalledTimes(25);
    expect(overlay.truncated).toBe(true);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Overlay backfill capped; some rows kept stored state' }),
      'webhooks'
    );
  });

  it('keeps the rest of the overlay when a backfill fetch fails', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [trainingWorkflow(1)] });
    mockGetWorkflow.mockRejectedValue(new Error('past retention'));

    const overlay = await getTrainingWorkflowOverlay({
      userId: 1,
      ctx,
      refs: [{ modelFileId: 500, workflowId: 'wf-500' }],
    });

    expect([...overlay.byModelFileId.keys()]).toEqual([1]);
  });
});
