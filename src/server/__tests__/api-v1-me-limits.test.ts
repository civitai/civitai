import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

const { getUsageLimits } = vi.hoisted(() => ({
  getUsageLimits: vi.fn(async () => ({ limits: [] as unknown[] })),
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/usage-limits.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUsageLimits,
}));

const handler = (await import('~/pages/api/v1/me/limits')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

const USER = { id: 7, username: 'u' } as SessionUser;

async function call({
  context = {},
  query = {},
}: { context?: Record<string, unknown>; query?: Record<string, string | string[]> } = {}) {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const req = { method: 'GET', headers: {}, query, context } as unknown as NextApiRequest;
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(value: unknown) {
      out.body = value;
      return res;
    },
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler(req, res, USER);
  return out;
}

const token = (tokenScope: number) => ({
  tokenScope,
  apiKeyId: 3,
  subject: { type: 'apiKey', id: 3 },
});

beforeEach(() => getUsageLimits.mockClear());

describe('GET /api/v1/me/limits', () => {
  it.each([
    ['a cookie session, as Full', {}, TokenScope.Full],
    ['a full-access key', token(TokenScope.Full), TokenScope.Full],
    ['a UserRead key', token(TokenScope.UserRead), TokenScope.UserRead],
    ['a MediaWrite key', token(TokenScope.MediaWrite), TokenScope.MediaWrite],
    [
      'a key with both',
      token(TokenScope.UserRead | TokenScope.MediaWrite),
      TokenScope.UserRead | TokenScope.MediaWrite,
    ],
  ])('serves %s, privately and uncached', async (_label, context, tokenScope) => {
    const res = await call({ context });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ limits: [] });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getUsageLimits).toHaveBeenCalledWith(
      expect.objectContaining({ user: USER, tokenScope })
    );
  });

  it('refuses a key with neither scope, before reading anything', async () => {
    const res = await call({ context: token(TokenScope.ModelsRead | TokenScope.ModelsWrite) });
    expect(res.status).toBe(403);
    expect(getUsageLimits).not.toHaveBeenCalled();
  });

  it('takes ids as a comma list or repeated params', async () => {
    await call({ query: { ids: 'posts.daily, posts.hourly' } });
    expect(getUsageLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ['posts.daily', 'posts.hourly'] })
    );
    await call({ query: { ids: ['posts.daily', 'posts.hourly'] } });
    expect(getUsageLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: ['posts.daily', 'posts.hourly'] })
    );
  });

  it('rejects an oversized ids list', async () => {
    const res = await call({
      query: { ids: Array.from({ length: 21 }, (_, i) => `x${i}`).join(',') },
    });
    expect(res.status).toBe(400);
    expect(getUsageLimits).not.toHaveBeenCalled();
  });
});
