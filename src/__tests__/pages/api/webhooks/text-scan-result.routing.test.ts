import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleTextScanCallback: vi.fn(),
  handleTextCategoryCallback: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
  handleEndpointError: vi.fn(),
}));
vi.mock('~/server/services/text-scan/callback', () => ({
  handleTextScanCallback: mocks.handleTextScanCallback,
}));
vi.mock('~/server/services/text-scan/category', () => ({
  handleTextCategoryCallback: mocks.handleTextCategoryCallback,
  TEXT_CATEGORY_CALLBACK_PASS: 'category',
}));

import handler from '~/pages/api/webhooks/text-scan-result';

const call = (query: Record<string, string>) =>
  (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', query, body: { workflowId: 'wf', status: 'succeeded' } } as NextApiRequest,
    {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as NextApiResponse
  );

beforeEach(() => vi.clearAllMocks());

describe('text-scan-result webhook routing', () => {
  it('sends a scan callback to the scan handler only', async () => {
    await call({ token: 't' });
    expect(mocks.handleTextScanCallback).toHaveBeenCalledTimes(1);
    expect(mocks.handleTextCategoryCallback).not.toHaveBeenCalled();
  });

  it('sends a ?pass=category callback to the category handler only', async () => {
    await call({ token: 't', pass: 'category' });
    expect(mocks.handleTextCategoryCallback).toHaveBeenCalledTimes(1);
    expect(mocks.handleTextScanCallback).not.toHaveBeenCalled();
  });
});
