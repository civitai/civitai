import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createApiRouter } from '~/server/utils/api-router';

function setup() {
  const handler = vi.fn();
  const router = createApiRouter({ 'homeblock/create': async () => ({ default: handler }) });
  const call = async (query: Record<string, string | string[]>) => {
    const req = { method: 'POST', query } as unknown as NextApiRequest;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as NextApiResponse;
    await router(req, res);
    return { req, res };
  };
  return { handler, call };
}

describe('createApiRouter', () => {
  it("hands the request to the route's handler without the catch-all's own param", async () => {
    const { handler, call } = setup();
    const { req, res } = await call({ path: ['homeblock', 'create'], id: '5' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(req, res);
    // defineModeratorEndpoint merges req.query over the body, so a leftover `path` would override a body field.
    expect(req.query).toEqual({ id: '5' });
  });

  it.each([['homeblock', 'nope'], ['constructor'], ['__proto__']])(
    'answers 404 for a path with no route: %s',
    async (...path) => {
      const { handler, call } = setup();
      const { res } = await call({ path });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(handler).not.toHaveBeenCalled();
    }
  );
});
