import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The boost quote and the boost charge are the SAME orchestrator call, told apart only by
 * `whatif=true` — and that flag rides through an `as never` cast, because the pinned client predates
 * the query. So a dropped spread or a `whatIf` typo still compiles, and "show me the price" silently
 * becomes "charge me": the quote fires when the queue card renders the panel, and again on confirm.
 * Nothing else in the suite would print anything.
 */

vi.mock('~/server/utils/errorHandling', () => ({
  throwBadRequestError: vi.fn().mockImplementation((msg) => new Error(`bad-request: ${msg}`)),
  throwAuthorizationError: vi.fn().mockImplementation((msg) => new Error(`auth: ${msg}`)),
  throwInsufficientFundsError: vi.fn().mockImplementation((msg) => new Error(`funds: ${msg}`)),
  throwInternalServerError: vi.fn().mockImplementation((msg) => new Error(`internal: ${msg}`)),
  throwRateLimitError: vi.fn().mockImplementation((msg) => new Error(`rate-limit: ${msg}`)),
  throwServiceUnavailableError: vi
    .fn()
    .mockImplementation((msg) => new Error(`unavailable: ${msg}`)),
}));

vi.mock('@civitai/client', () => ({
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn((error) => (error as { detail?: string })?.detail ?? 'orchestrator error'),
  createCivitaiClient: vi.fn().mockReturnValue({
    getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
  }),
}));

import { updateWorkflow as clientUpdateWorkflow } from '@civitai/client';
import { setWorkflowDownloadPriority } from '../workflows';

const ok = (data: unknown) => ({ data, error: undefined, response: { ok: true, status: 200 } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clientUpdateWorkflow).mockResolvedValue(
    ok({ cost: { fixed: { downloadPriority: 500 } } }) as never
  );
});

describe('setWorkflowDownloadPriority', () => {
  it('prices a boost WITHOUT charging — the whatif flag reaches the orchestrator', async () => {
    await setWorkflowDownloadPriority({ token: 'user-token', workflowId: 'wf-1', whatif: true });

    expect(clientUpdateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { workflowId: 'wf-1' },
        body: { downloadPriority: 'high' },
        query: { whatif: true },
      })
    );
  });

  it('charges with no query at all — a stray whatif there would never charge', async () => {
    await setWorkflowDownloadPriority({ token: 'user-token', workflowId: 'wf-1' });

    const [args] = vi.mocked(clientUpdateWorkflow).mock.calls[0] as [Record<string, unknown>];
    expect(args.body).toEqual({ downloadPriority: 'high' });
    expect(args).not.toHaveProperty('query');
  });

  it('returns the orchestrator reply, which carries the boost fee', async () => {
    const priced = await setWorkflowDownloadPriority({
      token: 'user-token',
      workflowId: 'wf-1',
      whatif: true,
    });

    expect(priced?.cost?.fixed?.downloadPriority).toBe(500);
  });

  it('maps a refused charge to insufficient funds, not a generic failure', async () => {
    vi.mocked(clientUpdateWorkflow).mockResolvedValue({
      data: undefined,
      error: { detail: 'not enough buzz' },
      response: { ok: false, status: 403 },
    } as never);

    await expect(
      setWorkflowDownloadPriority({ token: 'user-token', workflowId: 'wf-1' })
    ).rejects.toThrow(/funds:/);
  });

  it('maps an orchestrator outage to a retry-able failure', async () => {
    vi.mocked(clientUpdateWorkflow).mockResolvedValue({
      data: undefined,
      error: { detail: 'boom' },
      response: undefined,
    } as never);

    await expect(
      setWorkflowDownloadPriority({ token: 'user-token', workflowId: 'wf-1' })
    ).rejects.toThrow(/unavailable:/);
  });
});
