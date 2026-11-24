import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * `liftWorkflowMatureRestriction`, the App Blocks output unlock's orchestrator write, over a fake
 * `clientUpdateWorkflow`. Two failures are REPORTED and the caller answers each differently, so
 * each must come back as its own outcome rather than as a throw:
 *   - 403 → `insufficient-funds` (the orchestrator could not take the yellow charge);
 *   - no response at all (the client resolves `response: undefined` when the fetch throws, our
 *     timeout firing included) → `no-response`, the write possibly still in flight.
 * Any other failure throws as `throwOrchestratorFailure` maps it.
 */

vi.mock('@civitai/orchestration-client', () => ({
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  refreshBlob: vi.fn(),
  handleError: vi.fn((error) => (error as { detail?: string })?.detail ?? 'orchestrator error'),
  createCivitaiClient: vi.fn().mockReturnValue({
    getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
  }),
}));

import { updateWorkflow as clientUpdateWorkflow } from '@civitai/orchestration-client';
import { liftWorkflowMatureRestriction } from '../workflows';

const reply = (response: { ok: boolean; status: number } | undefined, error?: unknown) =>
  ({ data: undefined, error, response } as never);

const lift = () =>
  liftWorkflowMatureRestriction({
    token: 'user-token',
    workflowId: '42-1',
    signal: AbortSignal.timeout(30_000),
  });

beforeEach(() => {
  vi.mocked(clientUpdateWorkflow).mockReset();
});

describe('liftWorkflowMatureRestriction', () => {
  it('writes allowMatureContent: true to the workflow, with the signal', async () => {
    vi.mocked(clientUpdateWorkflow).mockResolvedValue(reply({ ok: true, status: 200 }));
    expect(await lift()).toStrictEqual({ outcome: 'lifted' });
    expect(clientUpdateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { workflowId: '42-1' },
        body: { allowMatureContent: true },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('403 is insufficient-funds, not a throw', async () => {
    vi.mocked(clientUpdateWorkflow).mockResolvedValue(
      reply({ ok: false, status: 403 }, { detail: 'insufficient buzz' })
    );
    expect(await lift()).toStrictEqual({ outcome: 'insufficient-funds' });
  });

  it('🔴 no response (our timeout fired) is no-response, not a throw', async () => {
    vi.mocked(clientUpdateWorkflow).mockResolvedValue(
      reply(undefined, new DOMException('The operation was aborted.', 'TimeoutError'))
    );
    expect(await lift()).toStrictEqual({ outcome: 'no-response' });
  });

  it('400 throws BAD_REQUEST', async () => {
    vi.mocked(clientUpdateWorkflow).mockResolvedValue(
      reply({ ok: false, status: 400 }, { errors: { allowMatureContent: ['not unlockable'] } })
    );
    const error = await lift().then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_REQUEST');
    expect((error as TRPCError).message).toBe('not unlockable');
  });

  it('a 5xx throws SERVICE_UNAVAILABLE', async () => {
    vi.mocked(clientUpdateWorkflow).mockResolvedValue(
      reply({ ok: false, status: 503 }, { detail: 'down' })
    );
    const error = await lift().then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });
});
