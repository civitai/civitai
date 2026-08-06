import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';
import { isAdminPath } from '$lib/server/auth/admin';

/**
 * The behavioural guard test proves the five admin form-action routes that exist TODAY are covered. This
 * pins the thing that actually recurs: someone adds a sixth privileged route, or moves one, and the
 * coverage silently stops matching the inventory.
 *
 * It asserts a LEDGER rather than a floor, so it fails when the set grows AND when it shrinks — a route
 * quietly disappearing from the guarded set is the same defect as one appearing outside it.
 */

const routesDir = resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'routes');

function pageServerFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      found.push(...pageServerFiles(full));
    } else if (entry.name === '+page.server.ts') {
      found.push(full);
    }
  }
  return found;
}

/** Route ids (`/admin/roles/[role]`) for every page that exports form actions. */
function actionRouteIds(): string[] {
  return pageServerFiles(routesDir)
    .filter((file) => /^export const actions\b/m.test(readFileSync(file, 'utf8')))
    .map((file) => `/${relative(routesDir, file).split(sep).slice(0, -1).join('/')}`)
    .sort();
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
      // Substitute a concrete value for any dynamic segment — the matcher sees request paths, not route ids.
      expect(isAdminPath(id.replace(/\[[^\]]+\]/g, 'x'))).toBe(true);
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
