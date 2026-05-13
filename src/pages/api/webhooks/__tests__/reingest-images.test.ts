import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockDbWrite, mockIngestImageBulk } = vi.hoisted(() => ({
  mockDbWrite: {
    $queryRaw: vi.fn(),
  },
  mockIngestImageBulk: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: any) => handler,
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/services/image.service', () => ({
  ingestImageBulk: mockIngestImageBulk,
}));

import handler from '~/pages/api/webhooks/reingest-images';

function createMockReqRes(overrides: Partial<NextApiRequest> = {}) {
  const req = {
    method: 'POST',
    query: {},
    body: {},
    ...overrides,
  } as unknown as NextApiRequest;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;

  return { req, res };
}

describe('POST /api/webhooks/reingest-images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 400 when body is missing required fields', async () => {
    const { req, res } = createMockReqRes({ body: {} });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it('should return 400 when imageIds is not an array of numbers', async () => {
    const { req, res } = createMockReqRes({
      body: { imageIds: 'not-an-array' },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it('should return 400 when imageIds array is empty', async () => {
    const { req, res } = createMockReqRes({
      body: { imageIds: [] },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('should return 200 with valid input', async () => {
    const images = [{ id: 1, url: 'https://example.com/img.png', type: 'image', width: 100, height: 100, prompt: '' }];
    mockDbWrite.$queryRaw.mockResolvedValue(images);
    mockIngestImageBulk.mockResolvedValue(true);

    const { req, res } = createMockReqRes({
      body: { imageIds: [1, 2, 3] },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, count: 1 })
    );
  });
});
