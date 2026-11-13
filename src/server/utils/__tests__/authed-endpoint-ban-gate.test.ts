import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_ACTIONS } from '@civitai/post-planner/contract';
import { BANNED_ACCOUNT_MESSAGE } from '~/server/utils/errorHandling';

const { getServerAuthSession, impersonation } = vi.hoisted(() => ({
  getServerAuthSession: vi.fn(),
  impersonation: {
    impersonate: vi.fn(async () => ({ ok: false, status: 400, error: 'stub' })),
    exit: vi.fn(async () => ({ ok: false, status: 400, error: 'stub' })),
  },
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession }));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createImpersonationClient: () => impersonation,
}));

import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

const API_DIR = join(process.cwd(), 'src/pages/api');

/**
 * Routes a banned account may still call, each for a reason a moderator signed off on. Adding a route
 * here is a moderation decision, not a code-review one: ask before you extend it.
 */
const ALLOW_BANNED = [
  'auth/freshdesk.ts',
  'auth/impersonate.ts',
  'download/user-transactions.ts',
  'v1/me.ts',
];
/** Approved routes with their own test: freshdesk in api-ban-gate.test.ts, impersonate below. */
const TESTED_SEPARATELY = ['auth/freshdesk.ts', 'auth/impersonate.ts'];

/** Routes that dispatch on the query before reaching their AuthedEndpoint. */
const QUERY: Record<string, Record<string, string>> = {
  'v1/posts/planner/[action].ts': { action: Object.keys(PLANNER_ACTIONS)[0] },
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = routeFiles(API_DIR).map((path) => ({
  route: relative(API_DIR, path).split('\\').join('/'),
  path,
  source: readFileSync(path, 'utf8'),
}));
const authedRoutes = sources.filter(({ source }) =>
  /\b(Authed|Orchestrator)Endpoint\(/.test(source)
);
const gatedRoutes = authedRoutes.filter(({ route }) => !ALLOW_BANNED.includes(route));

function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  query: Record<string, string> = {},
  { body = {}, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}
) {
  const result = { status: 0, body: undefined as unknown, handled: false };
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      result.handled = true;
      return res;
    },
    send(body: unknown) {
      result.body = body;
      result.handled = true;
      return res;
    },
    setHeader: () => res,
    getHeader: () => undefined,
    end: () => {
      result.handled = true;
      return res;
    },
    on: () => res,
    once: () => res,
    writeHead: () => res,
    write: () => true,
  };
  const req = { method, query, body, headers, cookies: {}, url: '/api/test' };
  return Promise.resolve(
    handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse)
  ).then(() => result);
}

const banned = { user: { id: 7, username: 'banned', bannedAt: new Date('2026-01-01') } };
const active = { user: { id: 7, username: 'active' } };

beforeEach(() => {
  getServerAuthSession.mockReset();
});

describe('AuthedEndpoint ban gate', () => {
  it('refuses a banned session before the handler runs', async () => {
    getServerAuthSession.mockResolvedValue(banned);
    const handler = vi.fn(async (_req, res: NextApiResponse) => res.status(200).json({ ok: true }));
    const result = await call(AuthedEndpoint(handler), 'GET');
    expect(result).toMatchObject({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('serves an account that is not banned', async () => {
    getServerAuthSession.mockResolvedValue(active);
    const handler = vi.fn(async (_req, res: NextApiResponse) => res.status(200).json({ ok: true }));
    expect(await call(AuthedEndpoint(handler), 'GET')).toMatchObject({ status: 200 });
  });

  it('serves a banned session on a route that opts in with allowBanned', async () => {
    getServerAuthSession.mockResolvedValue(banned);
    const handler = vi.fn(async (_req, res: NextApiResponse) => res.status(200).json({ ok: true }));
    const result = await call(AuthedEndpoint(handler, ['GET'], { allowBanned: true }), 'GET');
    expect(result).toMatchObject({ status: 200 });
  });
});

describe('allowBanned is used only by the approved routes', () => {
  it('matches the approved list exactly', () => {
    const using = sources
      .filter(({ source }) => /\ballowBanned\b/.test(source))
      .map(({ route }) => route)
      .sort();
    expect(using).toEqual([...ALLOW_BANNED].sort());
  });
});

describe('the approved routes still serve a banned session', () => {
  it.each(ALLOW_BANNED.filter((r) => !TESTED_SEPARATELY.includes(r)))(
    '%s does not answer the banned 403',
    async (route) => {
      getServerAuthSession.mockResolvedValue(banned);
      const { default: handler } = await import(/* @vite-ignore */ join(API_DIR, route));
      const results = await Promise.all(['GET', 'POST', 'DELETE'].map((m) => call(handler, m)));
      const served = results.filter((r) => r.status !== 405);
      expect(served.length).toBeGreaterThan(0);
      for (const r of served) expect(r.body).not.toEqual({ error: BANNED_ACCOUNT_MESSAGE });
    }
  );

  it('auth/impersonate lets a banned session exit but not start', async () => {
    getServerAuthSession.mockResolvedValue(banned);
    const { default: handler } = await import(
      /* @vite-ignore */ join(API_DIR, 'auth/impersonate.ts')
    );
    // A well-formed start request, so only the ban check can stop it.
    const start = await call(
      handler,
      'POST',
      {},
      { body: { userId: 8 }, headers: { 'content-type': 'application/json' } }
    );
    const exit = await call(handler, 'DELETE');
    expect(start).toMatchObject({ status: 403, body: { error: BANNED_ACCOUNT_MESSAGE } });
    expect(impersonation.impersonate).not.toHaveBeenCalled();
    expect(exit.body).not.toEqual({ error: BANNED_ACCOUNT_MESSAGE });
    expect(impersonation.exit).toHaveBeenCalled();
  });
});

describe('every authed API route refuses a banned session', () => {
  it('finds the authed routes', () => {
    expect(gatedRoutes.length).toBeGreaterThanOrEqual(33);
  });

  it.each(gatedRoutes.map(({ route, path }) => [route, path]))(
    '%s answers 403',
    async (route, path) => {
      getServerAuthSession.mockResolvedValue(banned);
      const { default: handler } = await import(/* @vite-ignore */ path);
      let result = { status: 405 } as Awaited<ReturnType<typeof call>>;
      for (const method of ['GET', 'POST', 'DELETE', 'PUT']) {
        result = await call(handler, method, QUERY[route]);
        if (result.status !== 405) break;
      }
      expect({ status: result.status, body: result.body }).toEqual({
        status: 403,
        body: { error: BANNED_ACCOUNT_MESSAGE },
      });
    },
    30_000
  );
});
