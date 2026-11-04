import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The two session routes of App Assistant's app activity:
 *  - GET  /api/apps/assistant/activity   the caller's own app's activity (the preview strip, the page tool)
 *  - POST /api/apps/dev/preview-errors   the dev-tunnel host's errors from the caller's live preview
 * Both act as the SESSION's user only: no body or query field names a user. Credential rules are
 * pinned in `moderator-route-wrappers.ledger.test.ts` (FULL_SCOPE_SESSION_ROUTES).
 */

const m = vi.hoisted(() => ({
  user: { id: 5103 },
  refusal: vi.fn<() => Promise<unknown>>(),
  fullScope: vi.fn(() => true),
  read: vi.fn<(opts: { userId: number; blockId: string }) => Promise<unknown>>(),
  store: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (
      handler: (req: unknown, res: unknown, user: unknown) => Promise<unknown>,
      methods?: string[]
    ) =>
    (req: { method: string }, res: { status: (n: number) => { json: (b: unknown) => unknown } }) =>
      (methods ?? ['GET']).includes(req.method)
        ? handler(req, res, m.user)
        : res.status(405).json({ error: 'Method not allowed' }),
}));
vi.mock('~/server/utils/require-full-scope-session', () => ({
  requireFullScopeSession: m.fullScope,
}));
vi.mock('~/server/services/app-assistant/app-assistant.service', () => ({
  getAppAssistantRefusal: m.refusal,
}));
vi.mock('~/server/services/app-assistant/app-activity.service', () => ({
  readAppActivity: m.read,
}));
// The real schema and caps; only the store is replaced (redis is the canonical setup mock).
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({ getActiveDevTunnel: vi.fn() }));
vi.mock('~/server/services/app-assistant/preview-errors.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storePreviewErrors: m.store,
}));

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const activityRoute = (await import('~/pages/api/apps/assistant/activity'))
  .default as unknown as Handler;
const errorsRoute = (await import('~/pages/api/apps/dev/preview-errors'))
  .default as unknown as Handler;

async function call(handler: Handler, req: { method: string; query?: unknown; body?: unknown }) {
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
  await handler({ query: {}, ...req } as unknown as NextApiRequest, res);
  return { status, body, cacheControl: headers.get('cache-control') };
}

const OWNER = 5103;
const OTHER = 6207;
const ACTIVITY = { app: 'slideshow', summary: 's', items: [], omitted: 0, unavailable: [] };

beforeEach(() => {
  vi.clearAllMocks();
  m.user = { id: OWNER };
  m.fullScope.mockReturnValue(true);
  m.refusal.mockResolvedValue(null);
  // Only the owner's read finds the app (the service's own lookup, `resolveDevPageBlockForAuthor`).
  m.read.mockImplementation(async ({ userId }) => (userId === OWNER ? ACTIVITY : null));
  m.store.mockResolvedValue({ status: 'stored', stored: 1 });
});

describe('GET /api/apps/assistant/activity', () => {
  it('answers the session user’s own app, uncached', async () => {
    expect(await call(activityRoute, { method: 'GET', query: { blockId: 'slideshow' } })).toEqual({
      status: 200,
      body: ACTIVITY,
      cacheControl: 'no-store',
    });
    expect(m.read).toHaveBeenCalledWith({ userId: OWNER, blockId: 'slideshow' });
  });

  it('answers another user 404 for the same app, and a query cannot name a user', async () => {
    m.user = { id: OTHER };
    const out = await call(activityRoute, {
      method: 'GET',
      query: { blockId: 'slideshow', userId: String(OWNER) },
    });
    expect(out).toMatchObject({ status: 404, body: { error: 'App not found' } });
    expect(m.read).toHaveBeenCalledWith({ userId: OTHER, blockId: 'slideshow' });
  });

  it('passes an App Assistant refusal through without reading anything', async () => {
    m.refusal.mockResolvedValue({
      status: 403,
      error: 'App Assistant is not available on this account',
    });
    expect(
      await call(activityRoute, { method: 'GET', query: { blockId: 'slideshow' } })
    ).toMatchObject({
      status: 403,
      body: { error: 'App Assistant is not available on this account' },
    });
    expect(m.read).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ blockId: '' }], [{ blockId: 'x'.repeat(65) }]])(
    'answers 400 for %j',
    async (query) => {
      expect((await call(activityRoute, { method: 'GET', query })).status).toBe(400);
      expect(m.read).not.toHaveBeenCalled();
    }
  );

  it('stops when the session is not full-scope', async () => {
    m.fullScope.mockReturnValue(false);
    await call(activityRoute, { method: 'GET', query: { blockId: 'slideshow' } });
    expect(m.read).not.toHaveBeenCalled();
  });
});

describe('POST /api/apps/dev/preview-errors', () => {
  const report = { message: 'boom', fatal: false, source: 'error', at: 1 };

  it('keeps the reports for the session user and app', async () => {
    expect(
      await call(errorsRoute, { method: 'POST', body: { blockId: 'slideshow', errors: [report] } })
    ).toEqual({ status: 200, body: { stored: 1 }, cacheControl: 'no-store' });
    expect(m.store).toHaveBeenCalledWith({
      userId: OWNER,
      blockId: 'slideshow',
      reports: [report],
    });
  });

  it('answers 404 when the caller has no live dev preview of that app (nothing kept)', async () => {
    m.store.mockResolvedValue({ status: 'not-found' });
    expect(
      await call(errorsRoute, { method: 'POST', body: { blockId: 'slideshow', errors: [report] } })
    ).toMatchObject({ status: 404, body: { error: 'No live preview of yours for this app' } });
  });

  it.each([
    [{ blockId: 'slideshow', errors: [] }],
    [{ blockId: 'slideshow', errors: [{ fatal: false }] }],
    [{ blockId: 'slideshow', errors: Array.from({ length: 21 }, () => report) }],
    [{ errors: [report] }],
  ])('answers 400 for %j and keeps nothing', async (body) => {
    expect((await call(errorsRoute, { method: 'POST', body })).status).toBe(400);
    expect(m.store).not.toHaveBeenCalled();
  });

  it('refuses a GET', async () => {
    expect((await call(errorsRoute, { method: 'GET' })).status).toBe(405);
  });
});
