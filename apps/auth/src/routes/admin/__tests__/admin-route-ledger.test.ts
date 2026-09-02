import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';
import { isAdminPath, isAdminRequest } from '$lib/server/auth/admin';

/**
 * The behavioural guard test proves the five admin form-action routes that exist TODAY are covered. This
 * pins the thing that actually recurs: someone adds a sixth privileged route, or moves one, and the
 * coverage silently stops matching the inventory.
 *
 * It asserts a LEDGER rather than a floor, so it fails when the set grows AND when it shrinks — a route
 * quietly disappearing from the guarded set is the same defect as one appearing outside it.
 */

const routesDir = resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'routes');

function routeFiles(dir: string, basename: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      found.push(...routeFiles(full, basename));
    } else if (entry.name === basename) {
      found.push(full);
    }
  }
  return found;
}

const routeId = (file: string) => `/${relative(routesDir, file).split(sep).slice(0, -1).join('/')}`;

/** Route ids (`/admin/roles/[role]`) for every page that exports form actions. */
function actionRouteIds(): string[] {
  return routeFiles(routesDir, '+page.server.ts')
    .filter((file) => /^export const actions\b/m.test(readFileSync(file, 'utf8')))
    .map(routeId)
    .sort();
}

/** Route ids for every `+server.ts` endpoint, whether or not it is privileged. */
function endpointRouteIds(): string[] {
  return routeFiles(routesDir, '+server.ts').map(routeId).sort();
}

// Routes whose form actions are reachable without a hub-admin session BY DESIGN — they are the
// unauthenticated / pre-consent steps of signing in. Anything else showing up outside /admin is a new
// privileged surface that has to be looked at, which is what makes this list worth pinning.
const PUBLIC_ACTION_ROUTES = ['/login', '/login/oauth/authorize', '/login/oauth/device'];

const ADMIN_ACTION_ROUTES = [
  '/admin/access',
  '/admin/membership',
  '/admin/roles',
  '/admin/roles/[role]',
  '/admin/spoke-domains',
];

/**
 * Every `+server.ts` in the app. The form-action ledger above scans only `+page.server.ts`, so it cannot
 * see endpoints at all — a new privileged one used to land with no signal whatsoever.
 *
 * The `/admin` gate in hooks.server.ts covers an endpoint only if it lives under `/admin`, and none do —
 * each one below carries its own check instead. So this list is deliberately EVERY endpoint, not the
 * privileged subset: which ones are privileged is the human judgement this ledger exists to force. Do not
 * "tidy" it down to the sensitive-looking ones — that reintroduces the blind spot it closes.
 */
const ENDPOINT_ROUTES = [
  '/.well-known/jwks.json',
  '/.well-known/openid-configuration',
  '/api/auth/accounts',
  '/api/auth/dev/login',
  '/api/auth/identity',
  '/api/auth/impersonate',
  '/api/auth/impersonate/exit',
  '/api/auth/jwks',
  '/api/auth/oauth/authorize',
  '/api/auth/oauth/device',
  '/api/auth/oauth/device-approve',
  '/api/auth/oauth/device-info',
  '/api/auth/oauth/device-token',
  '/api/auth/oauth/introspect',
  '/api/auth/oauth/legacy-exchange',
  '/api/auth/oauth/revoke',
  '/api/auth/oauth/session',
  '/api/auth/oauth/token',
  '/api/auth/oauth/userinfo',
  '/api/auth/providers',
  '/api/auth/refresh',
  '/api/auth/switch',
  '/api/health',
  '/discord/link-role',
  '/favicon.svg',
  '/login/[provider]',
  '/login/[provider]/callback',
  '/login/email/verify',
  '/logout',
  '/metrics',
];

describe('hub form-action route ledger', () => {
  const discovered = actionRouteIds();

  // Positive control: a scanner that silently found nothing would make every assertion below vacuous.
  it('discovers the form-action routes on disk', () => {
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered).toContain('/admin/spoke-domains');
  });

  it('is the exact set of form-action routes in the app', () => {
    expect(discovered).toEqual([...ADMIN_ACTION_ROUTES, ...PUBLIC_ACTION_ROUTES].sort());
  });

  it('routes every admin form-action route through the guard matcher', () => {
    const admin = discovered.filter((id) => id.startsWith('/admin'));

    expect(admin).toEqual(ADMIN_ACTION_ROUTES);
    for (const id of admin) {
      // Substitute a concrete value for any dynamic segment — the pathname arm sees request paths.
      expect(isAdminRequest(id.replace(/\[[^\]]+\]/g, 'x'), null)).toBe(true);
      // ...and the routed-id arm must cover it on its own, whatever path spelling reached it.
      expect(isAdminRequest('/', id)).toBe(true);
    }
  });

  it('matches the admin area itself and paths under it, and nothing that merely looks like one', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/')).toBe(true);
    expect(isAdminPath('/admin/roles/x/__data.json')).toBe(true);
    expect(isAdminPath('/administrators')).toBe(false);
    expect(isAdminPath('/login')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
  });
});

describe('hub +server.ts endpoint ledger', () => {
  const discovered = endpointRouteIds();

  // Positive control: a scanner that silently found nothing would make every assertion below vacuous.
  it('discovers the endpoints on disk', () => {
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered).toContain('/api/auth/impersonate');
  });

  it('is the exact set of endpoints in the app', () => {
    expect(discovered).toEqual([...ENDPOINT_ROUTES].sort());
  });

  it('routes any endpoint under /admin through the guard matcher', () => {
    // The set is empty today, which would make the loop below vacuous — so prove the mechanism directly:
    // an endpoint placed under /admin IS matched, by both arms, and one outside it is not.
    expect(isAdminRequest('/admin/tools', null)).toBe(true);
    expect(isAdminRequest('/', '/admin/tools')).toBe(true);
    expect(isAdminRequest('/api/auth/impersonate', '/api/auth/impersonate')).toBe(false);

    for (const id of discovered.filter((r) => r.startsWith('/admin'))) {
      expect(isAdminRequest(id.replace(/\[[^\]]+\]/g, 'x'), null)).toBe(true);
      expect(isAdminRequest('/', id)).toBe(true);
    }
  });
});
