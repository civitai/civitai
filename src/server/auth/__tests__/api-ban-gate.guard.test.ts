import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An API route reads the session through `getApiAuthSession`, which applies the ban. A direct
 * `getServerAuthSession` call or import under src/pages/api returns a banned user as if signed in, so it is
 * allowed only in the files below.
 *
 * Adding a file here lets a banned account's session through that route: that is a moderation
 * decision, not a code-review one.
 */
const RAW_SESSION_ALLOWED: Record<string, string> = {
  'auth/session.ts': 'the client reads the banned session to show the banned page',
  'auth/post-login.ts': 'a banned user signing in must land on the banned page',
  'auth/linked.ts': "syncs the user's Discord roles after an account is linked",
  'page-data/images/[imageId].ts': 'page bootstrap for the image page; it renders the banned page',
  'application-error.ts': 'client error reporting',
  'admin/creator-shop-fees.ts': 'webhook-token route; the session only labels the audit actor',
  'user/settings.ts': "returns the caller's own settings bootstrap, like auth/session",
};

const API_DIR = join(process.cwd(), 'src/pages/api');
// The import as well as the call, so an aliased import or a call by reference is caught too.
// `resolveSettingsBootstrap` reads the raw session itself, so calling it counts as a direct call.
const DIRECT_CALL =
  /get-server-auth-session['"]|\bgetServerAuthSession\s*\(|\bresolveSettingsBootstrap\s*\(/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const directCallers = routeFiles(API_DIR)
  .filter((path) => DIRECT_CALL.test(readFileSync(path, 'utf8')))
  .map((path) => relative(API_DIR, path).split('\\').join('/'));

describe('API routes resolve the session through the ban gate', () => {
  it('finds the direct callers it is meant to find', () => {
    // Without this the scan could match nothing and every assertion below would pass vacuously.
    expect(directCallers).toContain('auth/session.ts');
  });

  it('no route outside the allowlist calls getServerAuthSession directly', () => {
    expect(directCallers.filter((route) => !(route in RAW_SESSION_ALLOWED))).toEqual([]);
  });

  it('every allowlisted route still calls it, so the list cannot go stale', () => {
    const stale = Object.keys(RAW_SESSION_ALLOWED).filter(
      (route) => !directCallers.includes(route)
    );
    expect(stale).toEqual([]);
  });
});
