import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * The only paid call on this branch that is not a submit: a boost is one orchestrator PUT, and the
 * quote for it is the SAME PUT with `whatif=true`. Nothing downstream re-checks either property, so
 * a dropped flag charges on render, and a dropped price comparison charges whatever the price moved
 * to — both silently, on a path the billable-submit guard cannot see.
 */

const setWorkflowDownloadPriority = vi.fn();
const getWorkflow = vi.fn();
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  setWorkflowDownloadPriority: (...args: unknown[]) => setWorkflowDownloadPriority(...args),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
}));

import { boostWorkflow, getWorkflowBoostCost } from '../orchestration-new.service';

const priced = (fee: number | null) => ({
  cost: { fixed: fee == null ? {} : { downloadPriority: fee } },
});
const args = { token: 'tok', workflowId: '5-1', user: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  setWorkflowDownloadPriority.mockResolvedValue(priced(240));
  getWorkflow.mockResolvedValue({ id: '5-1', status: 'preparing', steps: [] });
});

describe('getWorkflowBoostCost', () => {
  it('prices with whatif, so opening a card cannot charge', async () => {
    await expect(getWorkflowBoostCost({ token: 'tok', workflowId: '5-1' })).resolves.toEqual({
      cost: 240,
    });
    expect(setWorkflowDownloadPriority).toHaveBeenCalledTimes(1);
    expect(setWorkflowDownloadPriority.mock.calls[0][0]).toMatchObject({ whatif: true });
  });

  it('reads no fee as nothing to boost', async () => {
    setWorkflowDownloadPriority.mockResolvedValue(priced(null));
    await expect(getWorkflowBoostCost({ token: 'tok', workflowId: '5-1' })).resolves.toEqual({
      cost: null,
    });
  });
});

describe('boostWorkflow', () => {
  it('charges once, unpriced, after quoting the price the user agreed to', async () => {
    const result = await boostWorkflow({ ...args, expectedCost: 240 });

    expect(result.boosted).toBe(true);
    expect(setWorkflowDownloadPriority).toHaveBeenCalledTimes(2);
    expect(setWorkflowDownloadPriority.mock.calls[0][0]).toMatchObject({ whatif: true });
    expect(setWorkflowDownloadPriority.mock.calls[1][0].whatif).toBeUndefined();
  });

  it('refuses to charge when the price moved under the user', async () => {
    const result = await boostWorkflow({ ...args, expectedCost: 100 });

    expect(result).toEqual({ boosted: false, cost: 240 });
    expect(setWorkflowDownloadPriority).toHaveBeenCalledTimes(1);
  });

  it('refuses to charge when there is nothing left to boost', async () => {
    setWorkflowDownloadPriority.mockResolvedValue(priced(null));

    const result = await boostWorkflow({ ...args, expectedCost: 240 });

    expect(result).toEqual({ boosted: false, cost: null });
    expect(setWorkflowDownloadPriority).toHaveBeenCalledTimes(1);
  });

  // The charge has already gone through by then, so a retry would pay twice.
  it('reports the boost as done when the read after the charge fails', async () => {
    setWorkflowDownloadPriority
      .mockResolvedValueOnce(priced(240))
      .mockResolvedValueOnce(priced(240));
    getWorkflow.mockRejectedValue(new Error('orchestrator down'));

    const result = await boostWorkflow({ ...args, expectedCost: 240 });

    expect(result).toEqual({ boosted: true, workflow: null });
  });
});
