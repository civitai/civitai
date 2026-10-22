import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/server/utils/errorHandling', () => ({
  throwBadRequestError: vi.fn().mockImplementation((msg) => new Error(`bad-request: ${msg}`)),
  throwAuthorizationError: vi.fn().mockImplementation((msg) => new Error(`auth: ${msg}`)),
  throwInsufficientFundsError: vi.fn().mockImplementation((msg) => new Error(`funds: ${msg}`)),
  throwInternalServerError: vi.fn().mockImplementation((msg) => new Error(`internal: ${msg}`)),
  throwRateLimitError: vi.fn().mockImplementation((msg) => new Error(`rate-limit: ${msg}`)),
  throwNotFoundError: vi.fn().mockImplementation((msg) => new Error(`not-found: ${msg}`)),
  throwServiceUnavailableError: vi
    .fn()
    .mockImplementation((msg) => new Error(`unavailable: ${msg}`)),
}));

vi.mock('@civitai/orchestration-client', () => ({
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

import {
  getWorkflow as clientGetWorkflow,
  updateWorkflow as clientUpdateWorkflow,
} from '@civitai/orchestration-client';
import { updateWorkflow } from '../workflows';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clientUpdateWorkflow).mockResolvedValue({
    data: undefined,
    error: { detail: 'The cap blocks every mature output.' },
    response: { ok: false, status: 400 },
  } as never);
});

describe('workflows.updateWorkflow refusal', () => {
  it("throws the orchestrator's refusal instead of returning the unchanged workflow", async () => {
    await expect(
      updateWorkflow({
        token: 't',
        workflowId: 'wf-1',
        allowMatureContent: true,
        throwOnError: true,
      })
    ).rejects.toThrow('bad-request: The cap blocks every mature output.');
    expect(clientGetWorkflow).not.toHaveBeenCalled();
  });
});
