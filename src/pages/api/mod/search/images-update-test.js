///pages/api/mod/search/
import { createMocks } from 'node-mocks-http';
import updateImageSearchIndex from '../../../../src/pages/api/mod/search/images-update';
import { dbRead } from '~/server/db/client';
import { updateDocs } from '~/server/meilisearch/client';
import { dataProcessor } from '~/server/db/db-helpers';

// Mock the database client and other dependencies
jest.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: jest.fn(),
    image: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock('~/server/meilisearch/client', () => ({
  updateDocs: jest.fn(),
}));

jest.mock('~/server/db/db-helpers', () => ({
  dataProcessor: jest.fn(),
}));

describe('GET /api/mod/search/images-update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 400 for invalid update method', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'invalidMethod' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ ok: false, message: 'Invalid update method' });
  });

  it('should process NSFW update successfully', async () => {
    dataProcessor.mockImplementationOnce(async ({ processor }) => {
      await processor({ start: 1, end: 10 });
    });

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'nsfw' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);
  });

  it('should process flags update successfully', async () => {
    dataProcessor.mockImplementationOnce(async ({ processor }) => {
      await processor({ start: 1, end: 10 });
    });

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'flags' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);
  });

  it('should process user update successfully', async () => {
    dbRead.$queryRaw.mockResolvedValueOnce([{ id: 1, userId: 1 }]); // Mock user data
    dbRead.image.findMany.mockResolvedValueOnce([{ id: 1, userId: 1 }]); // Mock image data
    updateDocs.mockResolvedValueOnce({}); // Mock updateDocs response

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'user' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);
  });

  it('should process dateFields update successfully', async () => {
    dbRead.$queryRaw.mockResolvedValueOnce([{ id: 1, publishedAt: new Date() }]); // Mock date data
    updateDocs.mockResolvedValueOnce({}); // Mock updateDocs response

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'dateFields' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);
  });

  it('should handle database errors gracefully', async () => {
    dbRead.$queryRaw.mockRejectedValueOnce(new Error('Database error'));

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'user' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(res._getData()).toContain('Database error');
  });

  it('should handle empty records gracefully', async () => {
    dataProcessor.mockImplementationOnce(async ({ processor }) => {
      await processor({ start: 1, end: 10 });
    });

    dbRead.$queryRaw.mockResolvedValueOnce([]); // Mock empty records

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'nsfw' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);
  });

  it('should handle large batch sizes', async () => {
    const largeBatch = Array.from({ length: 100000 }, (_, i) => ({ id: i + 1 }));

    dbRead.$queryRaw.mockResolvedValueOnce(largeBatch); // Mock large batch
    updateDocs.mockResolvedValueOnce({}); // Mock updateDocs response

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'nsfw' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);
  });

  it('should retry on transient errors', async () => {
    let callCount = 0;
    dataProcessor.mockImplementationOnce(async ({ processor }) => {
      if (callCount++ < 2) throw new Error('Transient error');
      await processor({ start: 1, end: 10 });
    });

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'nsfw' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);
  });

  it('should handle missing query parameters gracefully', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: {},
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ ok: false, message: 'Invalid update method' });
  });

  it('should handle unexpected errors gracefully', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'user' },
    });

    dbRead.$queryRaw.mockImplementationOnce(() => {
      throw new Error('Unexpected error');
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(res._getData()).toContain('Unexpected error');
  });

  it('should process multiple updates in sequence', async () => {
    dbRead.$queryRaw.mockResolvedValueOnce([{ id: 1, userId: 1 }]); // Mock user data
    dbRead.image.findMany.mockResolvedValueOnce([{ id: 1, userId: 1 }]); // Mock image data
    updateDocs.mockResolvedValueOnce({}); // Mock updateDocs response

    const { req, res } = createMocks({
      method: 'GET',
      query: { update: 'user' },
    });

    await updateImageSearchIndex(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toHaveProperty('ok', true);

    const { req: req2, res: res2 } = createMocks({
      method: 'GET',
      query: { update: 'dateFields' },
    });

    await updateImageSearchIndex(req2, res2);

    expect(res2._getStatusCode()).toBe(200);
    expect(res2._getJSONData()).toHaveProperty('ok', true);
  });
});
