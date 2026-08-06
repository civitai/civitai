import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MembershipModule from '$lib/server/auth/membership';
import type * as RolesModule from '$lib/server/auth/roles';

// `$lib/server/auth/admin` parses AUTH_ADMIN_USER_IDS once at module load, and hooks.server.ts imports it,
// so the allowlist has to exist before either module is evaluated.
const { writes, ADMIN_USER_ID } = vi.hoisted(() => {
  const ADMIN_USER_ID = 1;
  process.env.AUTH_ADMIN_USER_IDS = String(ADMIN_USER_ID);
  return { writes: [] as string[], ADMIN_USER_ID };
});

const NON_ADMIN_USER_ID = 99;

vi.mock('$lib/server/axiom', () => ({
  logAxiomError: vi.fn(),
  logToAxiom: vi.fn(async () => undefined),
}));

// db.ts builds a pg Pool at module load and throws without DATABASE_URL. The stub records the mutating
// builder entrypoints, which is the write signal for the two routes that hit Kysely directly.
vi.mock('$lib/server/db/db', () => {
  const queryChain = (): unknown => {
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          if (prop === 'execute') return async () => [];
          if (prop === 'executeTakeFirst') return async () => ({ id: 1 });
          return () => chain;
        },
      }
    );
    return chain;
  };
  return {
    db: {
      selectFrom: () => queryChain(),
      insertInto: (table: string) => {
        writes.push(`insertInto:${table}`);
        return queryChain();
      },
      updateTable: (table: string) => {
        writes.push(`updateTable:${table}`);
        return queryChain();
      },
      deleteFrom: (table: string) => {
        writes.push(`deleteFrom:${table}`);
        return queryChain();
      },
    },
  };
});

vi.mock('$lib/server/oauth/first-party', () => ({ invalidateDomainCache: vi.fn() }));
vi.mock('$lib/server/oauth/access', () => ({ invalidateRoleCache: vi.fn() }));

vi.mock('$lib/server/auth/verifier', () => ({
  verifier: { verifyToken: async (token: string) => ({ sub: token, jti: 'jti-test' }) },
}));

vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id, username: `user${id}` }),
  invalidateSessionUser: vi.fn(),
}));

// Only the writes are replaced. The validators these actions gate on (`isOverrideTier`, `roleId`) stay real,
// so a request that reaches the write had to pass the route's own input checks first.
vi.mock('$lib/server/auth/membership', async (importOriginal) => ({
  ...(await importOriginal<typeof MembershipModule>()),
  setOverride: vi.fn(async () => {
    writes.push('membership.setOverride');
    return { ok: true as const, user: { id: 7, username: 'target' } };
  }),
  removeOverride: vi.fn(async () => {
    writes.push('membership.removeOverride');
  }),
}));

vi.mock('$lib/server/auth/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof RolesModule>()),
  createRole: vi.fn(async () => {
    writes.push('roles.createRole');
    return true;
  }),
  deleteRole: vi.fn(async () => {
    writes.push('roles.deleteRole');
  }),
  addMember: vi.fn(async () => {
    writes.push('roles.addMember');
    return { ok: true as const, user: { id: 7, username: 'target' } };
  }),
  removeMember: vi.fn(async () => {
    writes.push('roles.removeMember');
  }),
}));

import { handle } from '../../../hooks.server';
import { SESSION_COOKIE } from '$lib/server/auth/session';

const ORIGIN = 'https://auth.example.test';

const ACTION_MODULES: Record<string, () => Promise<{ actions: Record<string, unknown> }>> = {
  '/admin/spoke-domains': () => import('../spoke-domains/+page.server'),
  '/admin/membership': () => import('../membership/+page.server'),
  '/admin/access': () => import('../access/+page.server'),
  '/admin/roles': () => import('../roles/+page.server'),
  '/admin/roles/[role]': () => import('../roles/[role]/+page.server'),
};

type Scenario = {
  name: string;
  routeId: string;
  path: string;
  action: string;
  form: Record<string, string>;
  params?: Record<string, string>;
  write: string;
};

/**
 * Every named form action the admin area exposes, with input that the route's OWN validation accepts.
 * That matters: an action rejected for a bad tier or an unparseable id would never reach its write, and a
 * test that went green on that would prove nothing about authorization.
 */
const ADMIN_ACTIONS: Scenario[] = [
  {
    name: 'spoke-domains create',
    routeId: '/admin/spoke-domains',
    path: '/admin/spoke-domains',
    action: 'create',
    form: { domain: 'attacker.example.com', includeSubdomains: 'on', enabled: 'on', label: 'x' },
    write: 'insertInto:TrustedSpokeDomain',
  },
  {
    name: 'spoke-domains update',
    routeId: '/admin/spoke-domains',
    path: '/admin/spoke-domains',
    action: 'update',
    form: { id: '1', domain: 'attacker.example.com', enabled: 'on' },
    write: 'updateTable:TrustedSpokeDomain',
  },
  {
    name: 'spoke-domains delete',
    routeId: '/admin/spoke-domains',
    path: '/admin/spoke-domains',
    action: 'delete',
    form: { id: '1' },
    write: 'deleteFrom:TrustedSpokeDomain',
  },
  {
    name: 'membership set',
    routeId: '/admin/membership',
    path: '/admin/membership',
    action: 'set',
    form: { user: '7', tier: 'gold', note: 'x' },
    write: 'membership.setOverride',
  },
  {
    name: 'membership remove',
    routeId: '/admin/membership',
    path: '/admin/membership',
    action: 'remove',
    form: { userId: '7' },
    write: 'membership.removeOverride',
  },
  {
    name: 'access setMode',
    routeId: '/admin/access',
    path: '/admin/access',
    action: 'setMode',
    form: { id: 'some-client', accessMode: 'open' },
    write: 'updateTable:OauthClient',
  },
  {
    name: 'roles create',
    routeId: '/admin/roles',
    path: '/admin/roles',
    action: 'create',
    form: { app: 'spoke', name: 'tester', description: 'x' },
    write: 'roles.createRole',
  },
  {
    name: 'roles delete',
    routeId: '/admin/roles',
    path: '/admin/roles',
    action: 'delete',
    form: { id: 'spoke:tester' },
    write: 'roles.deleteRole',
  },
  {
    name: 'roles/[role] add',
    routeId: '/admin/roles/[role]',
    path: '/admin/roles/tester',
    action: 'add',
    form: { user: '7', note: 'x' },
    params: { role: 'tester' },
    write: 'roles.addMember',
  },
  {
    name: 'roles/[role] remove',
    routeId: '/admin/roles/[role]',
    path: '/admin/roles/tester',
    action: 'remove',
    form: { userId: '7' },
    params: { role: 'tester' },
    write: 'roles.removeMember',
  },
];

/**
 * Drives the real `handle` hook the way SvelteKit does — the hook wraps `resolve`, and the form action runs
 * inside `resolve`. So `resolve` never being called is exactly "the action never ran".
 *
 * The requested path and the routed id are settable INDEPENDENTLY on purpose. SvelteKit matches routes on the
 * decoded pathname while `event.url.pathname` stays as sent, so the two can legitimately disagree; a harness
 * that derives one from the other cannot express that case at all, and silently shares whatever assumption
 * the code under test makes. `routedId: null` models "no route matched".
 */
async function post(
  scenario: Scenario,
  opts: {
    sessionUserId?: number;
    origin?: string | null;
    rawPath?: string;
    routedId?: string | null;
  } = {}
) {
  const rawPath = opts.rawPath ?? scenario.path;
  const routedId = opts.routedId === undefined ? scenario.routeId : opts.routedId;

  const url = new URL(`${ORIGIN}${rawPath}?/${scenario.action}`);
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.set('origin', origin);

  const cookies = new Map<string, string>();
  if (opts.sessionUserId !== undefined) cookies.set(SESSION_COOKIE, String(opts.sessionUserId));

  const request = new Request(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(scenario.form),
  });

  const event = {
    url,
    request,
    route: { id: routedId },
    params: scenario.params ?? {},
    locals: {} as Record<string, unknown>,
    cookies: { get: (name: string) => cookies.get(name) },
  };

  const resolve = vi.fn(async (ev: typeof event) => {
    if (routedId === null) return new Response('Not found', { status: 404 });
    const mod = await ACTION_MODULES[routedId]();
    const action = mod.actions[scenario.action] as (arg: unknown) => Promise<unknown>;
    const result = await action({
      request: ev.request,
      locals: ev.locals,
      params: ev.params,
      url: ev.url,
    });
    return new Response(JSON.stringify(result ?? null), { status: 200 });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await handle({ event: event as any, resolve: resolve as any });
  return { response, actionRan: resolve.mock.calls.length > 0 };
}

/** Percent-encode the first character of a path segment — decodes back to the same route. */
const encodeFirstChar = (path: string) => `/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`;

beforeEach(() => {
  writes.length = 0;
});

describe('hub /admin authorization', () => {
  // Positive control. Without this, "0 writes" below is indistinguishable from a harness wired to nothing.
  describe.each(ADMIN_ACTIONS)('$name', (scenario) => {
    it('performs its write for a hub admin', async () => {
      const { response, actionRan } = await post(scenario, { sessionUserId: ADMIN_USER_ID });

      expect(actionRan).toBe(true);
      expect(writes).toEqual([scenario.write]);
      expect(response.status).toBe(200);
    });

    it('is rejected with 403 and performs no write without a session', async () => {
      const { response, actionRan } = await post(scenario);

      expect(writes).toEqual([]);
      expect(actionRan).toBe(false);
      expect(response.status).toBe(403);
    });

    it('is rejected with 403 and performs no write for a signed-in non-admin', async () => {
      const { response, actionRan } = await post(scenario, { sessionUserId: NON_ADMIN_USER_ID });

      expect(writes).toEqual([]);
      expect(actionRan).toBe(false);
      expect(response.status).toBe(403);
    });

    it('is rejected with 403 and performs no write for a cross-origin post', async () => {
      const { response, actionRan } = await post(scenario, {
        sessionUserId: ADMIN_USER_ID,
        origin: 'https://attacker.example.test',
      });

      expect(writes).toEqual([]);
      expect(actionRan).toBe(false);
      expect(response.status).toBe(403);
    });

    // A missing Origin must be treated as untrusted, not waved through. Without this case a guard that
    // fails open on the absent header passes every other test in this file.
    it('is rejected with 403 and performs no write when the Origin header is absent', async () => {
      const { response, actionRan } = await post(scenario, {
        sessionUserId: ADMIN_USER_ID,
        origin: null,
      });

      expect(writes).toEqual([]);
      expect(actionRan).toBe(false);
      expect(response.status).toBe(403);
    });

    // SvelteKit routes on the decoded pathname, so a percent-encoded path reaches the same action while
    // spelling `event.url.pathname` differently. The guard has to agree with the router, not with the string.
    it('is rejected with 403 and performs no write for a percent-encoded path that routes here', async () => {
      const { response, actionRan } = await post(scenario, {
        rawPath: encodeFirstChar(scenario.path),
      });

      expect(writes).toEqual([]);
      expect(actionRan).toBe(false);
      expect(response.status).toBe(403);
    });
  });
});

describe('hub /admin guard shape', () => {
  const anyScenario = ADMIN_ACTIONS[0];

  // Scope: this is about the hook's OWN responses. SvelteKit normalizes a trailing slash with a 308 before
  // `handle` runs, and only for a path that matched a route, so the hook is not the only thing answering and
  // cannot make every /admin request indistinguishable.
  it('answers identically for a matched and an unmatched admin path', async () => {
    const real = await post(anyScenario);
    const unknown = await post(anyScenario, {
      rawPath: '/admin/no-such-route-here',
      routedId: null,
    });

    expect(real.response.status).toBe(403);
    expect(unknown.response.status).toBe(403);
    expect(await unknown.response.text()).toBe(await real.response.text());
  });

  it('rejects an unmatched /admin path rather than letting it fall through', async () => {
    const { response, actionRan } = await post(anyScenario, {
      rawPath: '/admin/future-route',
      routedId: null,
    });

    expect(actionRan).toBe(false);
    expect(response.status).toBe(403);
  });

  it('rejects a request routed to an admin route however the path was spelled', async () => {
    const { response, actionRan } = await post(anyScenario, {
      rawPath: '/%61dmin/spoke-domains',
      routedId: '/admin/spoke-domains',
    });

    expect(writes).toEqual([]);
    expect(actionRan).toBe(false);
    expect(response.status).toBe(403);
  });

  // The two arms of the guard cover different failure modes and would otherwise mask each other, so each
  // gets a case the other cannot answer.

  // Routed-id arm alone: a `reroute` hook or a configured base path can route a request to an admin route
  // from a path that does not resemble one, and no amount of decoding recovers that.
  it('rejects a request whose path is not admin-like but which routes to an admin route', async () => {
    const { response, actionRan } = await post(anyScenario, {
      rawPath: '/somewhere-else-entirely',
      routedId: '/admin/spoke-domains',
    });

    expect(writes).toEqual([]);
    expect(actionRan).toBe(false);
    expect(response.status).toBe(403);
  });

  // Decoded-pathname arm alone: an encoded admin path that matches no route has no routed id to consult.
  it('rejects an encoded admin path that matches no route', async () => {
    const { response, actionRan } = await post(anyScenario, {
      rawPath: '/%61dmin/no-such-route-here',
      routedId: null,
    });

    expect(actionRan).toBe(false);
    expect(response.status).toBe(403);
  });

  it('redirects an unauthenticated browser GET to login instead of 403ing it', async () => {
    const url = new URL(`${ORIGIN}/admin/spoke-domains`);
    const event = {
      url,
      request: new Request(url, { method: 'GET' }),
      route: { id: '/admin/spoke-domains' },
      params: {},
      locals: {} as Record<string, unknown>,
      cookies: { get: () => undefined },
    };
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await handle({ event: event as any, resolve: resolve as any });

    expect(resolve).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `/login?returnUrl=${encodeURIComponent('/admin/spoke-domains')}`
    );
  });

  it('leaves non-admin routes alone', async () => {
    const url = new URL(`${ORIGIN}/login`);
    const event = {
      url,
      request: new Request(url, { method: 'POST', body: new URLSearchParams({ a: 'b' }) }),
      route: { id: '/login' },
      params: {},
      locals: {} as Record<string, unknown>,
      cookies: { get: () => undefined },
    };
    const resolve = vi.fn(async () => new Response('ok', { status: 200 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await handle({ event: event as any, resolve: resolve as any });

    expect(resolve).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});
