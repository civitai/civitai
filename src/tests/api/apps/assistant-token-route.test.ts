import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { refusal, enable, mint, fullScope } = vi.hoisted(() => ({
  refusal: vi.fn<() => Promise<unknown>>(),
  enable: vi.fn(async () => undefined),
  mint: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fullScope: vi.fn(() => true),
}));

// Credential rules are pinned in `credential-minting-routes-session-scope.test.ts`.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => Promise<unknown>) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { id: 7 }),
}));
vi.mock('~/server/utils/require-full-scope-session', () => ({
  requireFullScopeSession: fullScope,
}));
vi.mock('~/server/services/app-assistant/app-assistant.service', () => ({
  getAppAssistantRefusal: refusal,
  enableAppAssistant: enable,
  mintAppAssistantToken: mint,
}));

const handler = (await import('~/pages/api/apps/assistant/token')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

async function call(
  method: 'GET' | 'POST',
  query: Record<string, unknown> = {},
  headers: Record<string, string> = method === 'POST' ? { 'content-type': 'application/json' } : {}
) {
  let status = 200;
  let body: unknown;
  const resHeaders = new Map<string, unknown>();
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    setHeader(k: string, v: unknown) {
      resHeaders.set(k.toLowerCase(), v);
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method, query, headers } as unknown as NextApiRequest, res);
  return { status, body, cacheControl: resHeaders.get('cache-control') };
}

const TOKEN = { token: 't', expiresAt: '2099-01-01T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  fullScope.mockReturnValue(true);
  refusal.mockResolvedValue(null);
  mint.mockResolvedValue(TOKEN);
});

describe('/api/apps/assistant/token', () => {
  it('GET mints a chat token, uncached, and never writes consent', async () => {
    expect(await call('GET')).toEqual({ status: 200, body: TOKEN, cacheControl: 'no-store' });
    expect(mint).toHaveBeenCalledWith(7, 'chat');
    expect(enable).not.toHaveBeenCalled();
  });

  it('GET ?for=sandbox mints the sandbox token', async () => {
    await call('GET', { for: 'sandbox' });
    expect(mint).toHaveBeenCalledWith(7, 'sandbox');
  });

  it('GET without consent answers 403 consent_required, and does not grant it', async () => {
    mint.mockResolvedValue(null);
    expect(await call('GET')).toMatchObject({
      status: 403,
      body: { code: 'consent_required' },
    });
    expect(enable).not.toHaveBeenCalled();
  });

  it('POST turns the assistant on, then mints a chat token', async () => {
    const order: string[] = [];
    enable.mockImplementation(async () => {
      order.push('enable');
    });
    mint.mockImplementation(async () => {
      order.push('mint');
      return TOKEN;
    });
    expect(await call('POST', { for: 'sandbox' })).toMatchObject({ status: 200, body: TOKEN });
    expect(order).toEqual(['enable', 'mint']);
    expect(mint).toHaveBeenCalledWith(7, 'chat');
  });

  it.each([[{ 'content-type': 'text/plain' }], [{}]])(
    'POST without JSON (%j) is refused before anything is written',
    async (headers) => {
      expect((await call('POST', {}, headers)).status).toBe(415);
      expect(enable).not.toHaveBeenCalled();
      expect(mint).not.toHaveBeenCalled();
    }
  );

  it('a refused caller gets the refusal and nothing is written or minted', async () => {
    refusal.mockResolvedValue({
      status: 403,
      error: 'App Assistant is not available on this account',
    });
    expect((await call('POST')).status).toBe(403);
    expect(enable).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it('a failed mint is a 503, not a crash', async () => {
    mint.mockRejectedValue(new Error('hub down'));
    expect((await call('GET')).status).toBe(503);
  });

  it('stops when the session is not full-scope', async () => {
    fullScope.mockReturnValue(false);
    await call('POST');
    expect(refusal).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
  });
});
