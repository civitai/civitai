import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/admin/page-access`: who may call it, and what is refused before any grant is touched. The
 * write itself (history order, compare-and-set) is `changePageRoles`, covered against a real database in
 * `page-access-change.pglite.test.ts`.
 */

const { changePageRoles, GrantConflictError, GrantHistoryUnavailableError } = vi.hoisted(() => {
  class GrantConflictError extends Error {
    readonly status = 409;
    constructor(readonly path: string, readonly current: string[]) {
      super(`${path} changed`);
    }
  }
  class GrantHistoryUnavailableError extends Error {
    readonly status = 503;
  }
  return {
    changePageRoles: vi.fn(async (input: { entries: { path: string; roles: string[] }[] }) => ({
      changed: input.entries.map((e) => ({ path: e.path, before: [], after: e.roles })),
    })),
    GrantConflictError,
    GrantHistoryUnavailableError,
  };
});
const grantableRoles = vi.hoisted(() =>
  vi.fn(
    async (): Promise<string[] | null> => ['moderator:mod-high-access', 'moderator:cm-high-access']
  )
);

vi.mock('$lib/server/page-access', () => ({
  changePageRoles,
  GrantConflictError,
  GrantHistoryUnavailableError,
}));
vi.mock('$lib/server/roles', () => ({ grantableRoles, NO_ROLE_CATALOGUE: 'no catalogue' }));

const { POST } = await import('../../../routes/api/admin/page-access/+server');

const ORIGIN = 'https://moderator.example.test';
const ADMIN = { id: 42, roles: ['moderator:admin'] };
const MOD = { id: 7, roles: ['moderator:mod-high-access'] };
const BODY = {
  path: '/blocklists',
  role: 'moderator:cm-high-access',
  op: 'grant',
  expect: ['moderator:mod-high-access'],
  gateRef: 'hub:request:test-card',
};

function call(
  opts: {
    user?: unknown;
    tokenClient?: string;
    body?: unknown;
    headers?: Record<string, string>;
    query?: string;
  } = {}
) {
  const url = new URL(`/api/admin/page-access${opts.query ?? ''}`, ORIGIN);
  const headers = new Headers(
    opts.headers ?? { origin: ORIGIN, 'content-type': 'application/json' }
  );
  const request = new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? BODY),
  });
  const locals = {
    user: 'user' in opts ? opts.user : ADMIN,
    tokenClient: opts.tokenClient,
    grants: {},
  };
  return POST({ request, url, locals, params: {} } as unknown as Parameters<typeof POST>[0]);
}

const status = async (p: Promise<Response>) => {
  try {
    return (await p).status;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

beforeEach(() => {
  changePageRoles.mockClear();
  grantableRoles.mockClear();
});

describe('POST /api/admin/page-access — who may call', () => {
  it('control: an admin session changes the grant, attributed and gated', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: true,
      path: '/blocklists',
      before: ['moderator:mod-high-access'],
      after: ['moderator:mod-high-access', 'moderator:cm-high-access'],
    });
    expect(changePageRoles).toHaveBeenCalledWith({
      entries: [
        { path: '/blocklists', roles: ['moderator:mod-high-access', 'moderator:cm-high-access'] },
      ],
      userId: 42,
      via: 'api',
      gateRef: 'hub:request:test-card',
      reason: null,
      expect: { '/blocklists': ['moderator:mod-high-access'] },
    });
  });

  it('refuses no session (401)', async () => {
    expect(await status(call({ user: null }))).toBe(401);
    expect(changePageRoles).not.toHaveBeenCalled();
  });

  it('refuses a moderator who cannot open /admin (403)', async () => {
    expect(await status(call({ user: MOD }))).toBe(403);
    expect(changePageRoles).not.toHaveBeenCalled();
  });

  // A service token has no person behind it to record. If this route were built as a webhook endpoint
  // the token would be accepted here.
  it('refuses a service token with no session (401)', async () => {
    // The message pins WHICH guard refused: the handler's own no-user check would also say 401.
    await expect(call({ user: null, tokenClient: 'webhook' })).rejects.toMatchObject({
      status: 401,
      body: { message: 'This endpoint is for signed-in moderators, not services.' },
    });
    expect(changePageRoles).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/page-access — refused before any write', () => {
  it.each([
    ['another origin', { origin: 'https://evil.example.test', 'content-type': 'application/json' }],
    ['no origin', { 'content-type': 'application/json' }],
    [
      'a form content type',
      { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    ],
  ])('%s → 403', async (_, headers) => {
    expect(await status(call({ headers }))).toBe(403);
    expect(changePageRoles).not.toHaveBeenCalled();
  });

  it.each([
    ['/admin itself', { path: '/admin' }],
    ['an unknown path', { path: '/no-such-page' }],
    // Six junk characters then a real permission id: a prefix strip that does not check the prefix.
    ['a mis-prefixed permission key', { path: 'XXXXXXassistant.use' }],
    ['the admin role', { role: 'moderator:admin' }],
    ['a role the hub does not list', { role: 'moderator:invented' }],
  ])('%s → 400', async (_, patch) => {
    expect(await status(call({ body: { ...BODY, ...patch } }))).toBe(400);
    expect(changePageRoles).not.toHaveBeenCalled();
  });

  it('a change named in the query string → 400', async () => {
    expect(await status(call({ query: '?path=/decisions' }))).toBe(400);
    expect(changePageRoles).not.toHaveBeenCalled();
  });

  it('no gateRef → 400', async () => {
    const { gateRef: _, ...body } = BODY;
    expect(await status(call({ body }))).toBe(400);
    expect(changePageRoles).not.toHaveBeenCalled();
  });

  it('an unreadable role catalogue → 503', async () => {
    grantableRoles.mockResolvedValueOnce(null);
    expect(await status(call())).toBe(503);
    expect(changePageRoles).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/page-access — the change', () => {
  it('revoke removes only the named role', async () => {
    await call({ body: { ...BODY, op: 'revoke', role: 'moderator:mod-high-access' } });
    expect(changePageRoles.mock.calls[0][0].entries).toEqual([{ path: '/blocklists', roles: [] }]);
  });

  it('carries every other stored role, retired or not, unchanged', async () => {
    await call({ body: { ...BODY, expect: ['moderator:retired', 'moderator:mod-high-access'] } });
    expect(changePageRoles.mock.calls[0][0].entries).toEqual([
      {
        path: '/blocklists',
        roles: ['moderator:retired', 'moderator:mod-high-access', 'moderator:cm-high-access'],
      },
    ]);
  });

  // A role from outside the catalogue (a service account's) has no column on /admin, so this route is
  // the one way to take it off a grant: it may be revoked once it is stored, never granted.
  describe('a role the auth hub catalogue does not list', () => {
    const SYSTEM = 'system:dispute-agent';

    it('is revoked when the grant holds it', async () => {
      const res = await call({
        body: {
          ...BODY,
          op: 'revoke',
          role: SYSTEM,
          expect: ['moderator:mod-high-access', SYSTEM],
        },
      });
      expect(res.status).toBe(200);
      expect(changePageRoles.mock.calls[0][0]).toMatchObject({
        entries: [{ path: '/blocklists', roles: ['moderator:mod-high-access'] }],
        expect: { '/blocklists': ['moderator:mod-high-access', SYSTEM] },
      });
    });

    it('is never granted, even when the grant already holds it', async () => {
      expect(await status(call({ body: { ...BODY, role: SYSTEM } }))).toBe(400);
      expect(await status(call({ body: { ...BODY, role: SYSTEM, expect: [SYSTEM] } }))).toBe(400);
      expect(changePageRoles).not.toHaveBeenCalled();
    });

    it('is revoked while the catalogue cannot be read', async () => {
      grantableRoles.mockResolvedValueOnce(null);
      const res = await call({ body: { ...BODY, op: 'revoke', role: SYSTEM, expect: [SYSTEM] } });
      expect(res.status).toBe(200);
      expect(changePageRoles.mock.calls[0][0].entries).toEqual([
        { path: '/blocklists', roles: [] },
      ]);
    });

    it('is refused for a revoke when the grant does not hold it', async () => {
      expect(await status(call({ body: { ...BODY, op: 'revoke', role: SYSTEM } }))).toBe(400);
      expect(changePageRoles).not.toHaveBeenCalled();
    });
  });

  it('a moved grant is a 409 carrying the current roles', async () => {
    changePageRoles.mockRejectedValueOnce(
      new GrantConflictError('/blocklists', ['moderator:cm-high-access'])
    );
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).current).toEqual(['moderator:cm-high-access']);
  });

  it('history unavailable is a 503', async () => {
    changePageRoles.mockRejectedValueOnce(new GrantHistoryUnavailableError('missing'));
    expect(await status(call())).toBe(503);
  });
});
