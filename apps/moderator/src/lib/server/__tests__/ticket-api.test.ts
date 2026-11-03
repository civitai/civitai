import { beforeEach, describe, expect, it, vi } from 'vitest';

const canAccess = vi.fn();
const loadTicketPayload = vi.fn();

vi.mock('$lib/server/access', () => ({
  canAccess: (...a: unknown[]) => canAccess(...a),
  requireAccess: (user: unknown, path: string) => {
    if (!canAccess(user, path)) throw Object.assign(new Error('forbidden'), { status: 403 });
  },
}));
vi.mock('$lib/server/tickets/detail', () => ({
  loadTicketPayload: (...a: unknown[]) => loadTicketPayload(...a),
}));

const { GET } = await import('../../../routes/api/tickets/[id]/+server');

const USER = { id: 4 };
const call = async (
  opts: { id?: string; view?: string | null; user?: unknown; grants?: Record<string, boolean> } = {}
) => {
  const view = 'view' in opts ? opts.view : 'moderation';
  const url = new URL(
    `https://x.test/api/tickets/${opts.id ?? '74924'}${view ? `?view=${view}` : ''}`
  );
  const locals = { user: 'user' in opts ? opts.user : USER, grants: opts.grants ?? {} };
  return GET({ params: { id: opts.id ?? '74924' }, url, locals } as unknown as Parameters<
    typeof GET
  >[0]);
};

const status = async (p: Promise<Response>) => {
  try {
    return (await p).status;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

const ok = {
  status: 'ok',
  ticket: { id: '74924' },
  conversation: { status: 'found', messages: [] },
};

beforeEach(() => {
  canAccess.mockReset().mockReturnValue(true);
  loadTicketPayload.mockReset().mockResolvedValue(ok);
});

describe('GET /api/tickets/[id]', () => {
  it('serves the payload to a moderator who can open the view, uncached', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual(ok);
    expect(canAccess).toHaveBeenCalledWith(USER, '/tickets/moderation');
  });

  it('checks the grant of the view asked for, not the other one', async () => {
    canAccess.mockImplementation((_u: unknown, path: string) => path === '/tickets/support');
    expect(await status(call({ view: 'moderation' }))).toBe(403);
    expect(loadTicketPayload).not.toHaveBeenCalled();
    expect(await status(call({ view: 'support' }))).toBe(200);
  });

  it('refuses no session and a missing or unknown view before reading anything', async () => {
    expect(await status(call({ user: null }))).toBe(403);
    expect(await status(call({ view: null }))).toBe(400);
    expect(await status(call({ view: 'billing' }))).toBe(400);
    expect(loadTicketPayload).not.toHaveBeenCalled();
  });

  it('passes the PII grant through, and only when held', async () => {
    await call({ grants: { 'decisions.support.pii': true } });
    expect(loadTicketPayload).toHaveBeenLastCalledWith('moderation', '74924', {
      canSeeEmail: true,
      canRead: expect.any(Function),
    });
    await call();
    expect(loadTicketPayload).toHaveBeenLastCalledWith('moderation', '74924', {
      canSeeEmail: false,
      canRead: expect.any(Function),
    });
  });

  it("lets the loader read the viewer's page grants, so each panel can be withheld", async () => {
    canAccess.mockImplementation((_u: unknown, path: string) => path !== '/retool/user-lookup');
    await call();
    const { canRead } = loadTicketPayload.mock.lastCall![2] as { canRead: (p: string) => boolean };
    expect(canRead('/retool/user-lookup')).toBe(false);
    expect(canRead('/images/appeals')).toBe(true);
    expect(canAccess).toHaveBeenCalledWith(USER, '/retool/user-lookup');
  });

  it("answers the loader's refusal: 404 for a ticket of the other view, 503 when Freshdesk is down", async () => {
    loadTicketPayload.mockResolvedValueOnce({
      status: 'refused',
      code: 404,
      message: 'other view',
    });
    expect(await status(call())).toBe(404);
    loadTicketPayload.mockResolvedValueOnce({ status: 'refused', code: 503, message: 'down' });
    expect(await status(call())).toBe(503);
  });
});
