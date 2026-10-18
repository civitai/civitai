import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockCreateModelFileScanRequest } = vi.hoisted(() => ({
  mockCreateModelFileScanRequest: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: unknown) => handler,
}));
// The real orchestrator module runs env validation on import.
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: mockCreateModelFileScanRequest,
  ModelFileScanSubmissionError: class extends Error {},
}));

import handler from '~/pages/api/mod/clean-up';
import { dbMock } from '~/__tests__/mocks/db.mock';

function createMocks(query: Record<string, string>) {
  const req = { method: 'GET', query } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mod/clean-up', () => {
  // Low-priority model-file scans fail before a worker claims them, so a re-queue at
  // low never completes.
  it('re-queues model file scans at normal priority', async () => {
    dbMock.dbRead.modelFile.findMany.mockResolvedValue([
      {
        id: 1,
        url: 's3://k1',
        modelVersion: { id: 10, baseModel: 'SDXL', model: { id: 100, type: 'LORA' } },
      },
    ]);
    mockCreateModelFileScanRequest.mockResolvedValue(undefined);
    const { req, res } = createMocks({ modelFileIds: '1', wait: 'true' });

    await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(req, res);

    expect(mockCreateModelFileScanRequest).toHaveBeenCalledWith({
      fileId: 1,
      modelVersionId: 10,
      modelId: 100,
      modelType: 'LORA',
      baseModel: 'SDXL',
      url: 's3://k1',
      priority: 'normal',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
