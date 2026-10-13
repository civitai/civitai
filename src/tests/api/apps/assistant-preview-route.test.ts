import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { refusal, preview, fullScope } = vi.hoisted(() => ({
  refusal: vi.fn<() => Promise<unknown>>(),
  preview: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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
  getAppAssistantPreview: preview,
}));

const handler = (await import('~/pages/api/apps/assistant/preview')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

async function call(query: Record<string, unknown>) {
  let status = 200;
  let body: unknown;
  const headers = new Map<string, unknown>();
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
      headers.set(k.toLowerCase(), v);
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', query } as unknown as NextApiRequest, res);
  return { status, body, cacheControl: headers.get('cache-control') };
}

const FRAME = { blockId: 'my-app', iframeSrc: 'https://dev-0123456789abcdef.apps.example/?dev=t' };

beforeEach(() => {
  vi.clearAllMocks();
  fullScope.mockReturnValue(true);
  refusal.mockResolvedValue(null);
});

describe('GET /api/apps/assistant/preview', () => {
  it('returns the frame, uncached, for the requested app', async () => {
    preview.mockResolvedValue({ status: 'ok', frame: FRAME });
    expect(await call({ blockId: 'my-app' })).toEqual({
      status: 200,
      body: FRAME,
      cacheControl: 'no-store',
    });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ blockId: 'my-app' }));
  });

  it('answers a tunnel that is still coming online with no frame to mount', async () => {
    preview.mockResolvedValue({ status: 'preparing' });
    expect(await call({ blockId: 'my-app' })).toEqual({
      status: 200,
      body: { preparing: true },
      cacheControl: 'no-store',
    });
  });

  it.each([
    [{ status: 'forbidden', error: 'Live preview is not available on this account' }, 403],
    [{ status: 'not-found' }, 404],
    [{ status: 'no-tunnel' }, 409],
  ])('maps %j to %i', async (result, status) => {
    preview.mockResolvedValue(result);
    expect((await call({ blockId: 'my-app' })).status).toBe(status);
  });

  it('passes a refusal straight through without resolving anything', async () => {
    refusal.mockResolvedValue({
      status: 403,
      error: 'App Assistant is not available on this account',
    });
    expect(await call({ blockId: 'my-app' })).toMatchObject({
      status: 403,
      body: { error: 'App Assistant is not available on this account' },
    });
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ blockId: '' }], [{ blockId: 'x'.repeat(65) }], [{ blockId: ['a', 'b'] }]])(
    'answers 400 for %j',
    async (query) => {
      expect((await call(query)).status).toBe(400);
      expect(preview).not.toHaveBeenCalled();
    }
  );

  it('stops when the session is not full-scope', async () => {
    fullScope.mockReturnValue(false);
    await call({ blockId: 'my-app' });
    expect(refusal).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });
});
