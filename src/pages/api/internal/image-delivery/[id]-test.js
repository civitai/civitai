// tests/pages/api/internal/image-delivery/[id].test.ts
import { createMocks } from 'node-mocks-http';
import handler from '../../../../src/pages/api/internal/image-delivery/[id]';
import { dbRead } from '~/server/db/client';

// Mock the database client
jest.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: jest.fn(),
  },
}));

describe('GET /api/internal/image-delivery/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 400 if id is missing', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: {},
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Missing image id' });
  });

  it('should return 400 if id is invalid', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { id: '' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid id: [Array of errors]' });
  });

  it('should return 404 if image is not found', async () => {
    dbRead.$queryRaw.mockResolvedValueOnce([]);

    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'nonexistent-url' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'Image not found' });
  });

  it('should return 200 and the image data if image is found', async () => {
    const mockImage = { id: 1, url: 'valid-url', hideMeta: false };
    dbRead.$queryRaw.mockResolvedValueOnce([mockImage]);

    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'valid-url' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(mockImage);
  });

  it('should handle database errors gracefully', async () => {
    dbRead.$queryRaw.mockRejectedValueOnce(new Error('Database error'));

    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'valid-url' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(res._getData()).toContain('Database error');
  });

  it('should handle unexpected errors gracefully', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'valid-url' },
    });

    dbRead.$queryRaw.mockImplementationOnce(() => {
      throw new Error('Unexpected error');
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(500);
    expect(res._getData()).toContain('Unexpected error');
  });

  it('should return 400 for non-string id', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 12345 }, // Non-string id
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid id: [Array of errors]' });
  });

  it('should return 200 and handle hideMeta correctly', async () => {
    const mockImage = { id: 1, url: 'valid-url', hideMeta: true };
    dbRead.$queryRaw.mockResolvedValueOnce([mockImage]);

    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'valid-url' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(mockImage);
  });

  it('should handle multiple images with the same id gracefully', async () => {
    const mockImages = [
      { id: 1, url: 'valid-url', hideMeta: false },
      { id: 2, url: 'valid-url', hideMeta: true },
    ];
    dbRead.$queryRaw.mockResolvedValueOnce(mockImages);

    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'valid-url' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(mockImages[0]); // Assuming the first one is returned
  });

  it('should return 400 for malformed query parameters', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'valid-url', extra: 'unexpected' },
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid query parameters' });
  });

  it('should handle large id values gracefully', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { id: 'a'.repeat(1000) }, // Very large id
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid id: [Array of errors]' });
  });
});
