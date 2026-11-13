import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';

import { dbMock } from '~/__tests__/mocks/db.mock';

const mockFindUnique = dbMock.dbWrite.blockUserSubscription.findUnique;
const { mockUpdateSettings } = vi.hoisted(() => ({ mockUpdateSettings: vi.fn() }));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { updateSettings: mockUpdateSettings },
}));

import handler from '~/pages/api/testing/blocks';

async function setBudget(buzzBudgetPerGen: number) {
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    setHeader: () => res,
    end: () => res,
  };
  await handler(
    {
      method: 'POST',
      // The endpoint captured this secret when its module loaded.
      query: { token: env.WEBHOOK_TOKEN },
      headers: {},
      body: { action: 'set-buzz-budget', blockInstanceId: 'inst_1', buzzBudgetPerGen },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return statusCode;
}

describe('testing/blocks set-buzz-budget — bounded by the per-call cap', () => {
  beforeEach(() => {
    mockFindUnique.mockReset().mockResolvedValue({
      targetModelIds: [77],
      settings: {},
      appBlock: { blockId: 'blk' },
    });
    mockUpdateSettings.mockReset().mockResolvedValue(undefined);
  });

  // 3137 sits between the old cap (1000) and the current one (5000).
  it.each([[1], [3137], [5000]])('accepts %i and stores it', async (value) => {
    expect(await setBudget(value)).toBe(200);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      blockInstanceId: 'inst_1',
      modelId: 77,
      settings: { buzz_budget_per_gen: value },
    });
  });

  it.each([[5001], [6301], [0]])('refuses %i and stores nothing', async (value) => {
    expect(await setBudget(value)).toBe(400);
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });
});
