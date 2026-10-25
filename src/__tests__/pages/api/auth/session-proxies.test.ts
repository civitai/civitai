import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EnvOther from '~/env/other';
import type * as CivitaiAuth from '@civitai/auth';
import type * as CivCookie from '~/server/auth/civ-cookie';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as ServerDomain from '~/server/utils/server-domain';

/**
 * The main app's account-switch and impersonation proxies act on the caller's session cookie, so they
 * accept only a JSON call from one of this app's own origins. The legacy oauth proxy does not forward the
 * hub's device approval endpoints.
 */

const h = vi.hoisted(() => {
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  return {
    prod: { value: true },
    switch: vi.fn(async () => ({ token: 'switched' })),
    remove: vi.fn(async () => true),
    impersonate: vi.fn(async () => ({ ok: true as const, token: 'imp' })),
    exit: vi.fn(async () => ({ ok: true as const, token: 'mod' })),
  };
});

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  get isProd() {
    return h.prod.value;
  },
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  getAllServerHosts: () => ['civitai.com', 'civitai.red'],
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createDeviceAccountClient: () => ({ switch: h.switch, remove: h.remove }),
  createImpersonationClient: () => ({ impersonate: h.impersonate, exit: h.exit }),
}));
vi.mock('~/server/auth/civ-cookie', async (importOriginal) => ({
  ...(await importOriginal<typeof CivCookie>()),
  setSessionCookie: vi.fn(),
}));
vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: async () => ({ user: { id: 1, isModerator: true } }),
}));

import switchHandler from '~/pages/api/auth/switch';
import impersonateHandler from '~/pages/api/auth/impersonate';
import oauthProxy from '~/pages/api/auth/oauth/[...path]';
import accountsHandler from '~/pages/api/auth/accounts';

const JSON_TYPE = { 'content-type': 'application/json' };
const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' };

function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  {
    method = 'POST',
    headers = {},
    body,
    url = '/',
    query = {},
  }: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    url?: string;
    query?: Record<string, string | string[]>;
  }
) {
  const req = Object.assign(Readable.from([]), {
    method,
    headers: { cookie: 'civ-token=t', ...headers },
    body,
    url,
    query,
    cookies: {},
  }) as unknown as NextApiRequest;
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(payload: unknown) {
      out.body = payload;
      return res;
    },
    send(payload: unknown) {
      out.body = payload;
      return res;
    },
    end: () => res,
    redirect: (code: number) => {
      out.status = code;
    },
    setHeader: () => res,
    getHeader: () => undefined,
  } as unknown as NextApiResponse;
  return Promise.resolve(handler(req, res)).then(() => out);
}

beforeEach(() => {
  h.prod.value = true;
  h.switch.mockClear();
  h.impersonate.mockClear();
  h.exit.mockClear();
  h.remove.mockClear();
});

describe('POST /api/auth/switch', () => {
  it('refuses a call from another origin without reaching the hub', async () => {
    const res = await call(switchHandler, {
      headers: { origin: 'https://evil.example', ...JSON_TYPE },
      body: { userId: 2 },
    });
    expect(res.status).toBe(403);
    expect(h.switch).not.toHaveBeenCalled();
  });

  it('refuses a call naming no origin', async () => {
    const res = await call(switchHandler, { headers: JSON_TYPE, body: { userId: 2 } });
    expect(res.status).toBe(403);
    expect(h.switch).not.toHaveBeenCalled();
  });

  it('refuses a form-encoded body from its own origin', async () => {
    const res = await call(switchHandler, {
      headers: { origin: 'https://civitai.com', ...FORM_TYPE },
      body: { userId: '2' },
    });
    expect(res.status).toBe(415);
    expect(h.switch).not.toHaveBeenCalled();
  });

  it("switches for a JSON call from the app's own origins (positive control)", async () => {
    for (const origin of ['https://civitai.com', 'https://civitai.red']) {
      const res = await call(switchHandler, {
        headers: { origin, ...JSON_TYPE },
        body: { userId: 2 },
      });
      expect(res.status).toBe(200);
    }
    expect(h.switch).toHaveBeenCalledTimes(2);
  });
});

describe('/api/auth/impersonate', () => {
  it('refuses a start from another origin', async () => {
    const res = await call(impersonateHandler, {
      headers: { origin: 'https://evil.example', ...JSON_TYPE },
      body: { userId: 2 },
    });
    expect(res.status).toBe(403);
    expect(h.impersonate).not.toHaveBeenCalled();
  });

  it('refuses an exit from another origin', async () => {
    const res = await call(impersonateHandler, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('refuses a form-encoded start', async () => {
    const res = await call(impersonateHandler, {
      headers: { origin: 'https://civitai.com', ...FORM_TYPE },
      body: { userId: '2' },
    });
    expect(res.status).toBe(415);
    expect(h.impersonate).not.toHaveBeenCalled();
  });

  it('starts and exits for same-origin calls (positive control)', async () => {
    const start = await call(impersonateHandler, {
      headers: { origin: 'https://civitai.com', ...JSON_TYPE },
      body: { userId: 2 },
    });
    const exit = await call(impersonateHandler, {
      method: 'DELETE',
      headers: { origin: 'https://civitai.com' },
    });
    expect([start.status, exit.status]).toEqual([200, 200]);
  });
});

describe('DELETE /api/auth/accounts', () => {
  it('refuses a removal from another origin', async () => {
    const res = await call(accountsHandler, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example' },
      query: { userId: '2' },
    });
    expect(res.status).toBe(403);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('removes for a same-origin call (positive control)', async () => {
    const res = await call(accountsHandler, {
      method: 'DELETE',
      headers: { origin: 'https://civitai.com' },
      query: { userId: '2' },
    });
    expect(res.status).toBe(200);
    expect(h.remove).toHaveBeenCalledOnce();
  });
});

describe('legacy /api/auth/oauth/* proxy', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each(['device-approve', 'device-deny'])('does not forward %s to the hub', async (path) => {
    const res = await call(oauthProxy, {
      url: `/api/auth/oauth/${path}`,
      query: { path: [path] },
      headers: { origin: 'https://civitai.com', ...JSON_TYPE },
    });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still forwards the token endpoint (positive control)', async () => {
    const res = await call(oauthProxy, {
      url: '/api/auth/oauth/token',
      query: { path: ['token'] },
      headers: FORM_TYPE,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.civitai.com/api/auth/oauth/token',
      expect.anything()
    );
  });
});
