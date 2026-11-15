import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * `STANDALONE_SERVER_PROFILE` -> profile, and each profile's page list. Unset must be the `trpc`
 * profile with EXACTLY the list the server served before profiles existed, so a deployment that
 * never sets the variable is unchanged. The `api` profile's relationship to the proxy is pinned in
 * `src/server/middleware/__tests__/proxy-standalone-pages.test.ts`.
 */

const require = createRequire(import.meta.url);
const served = require('../served-pages.cjs');

describe('resolveProfile', () => {
  it.each([
    [undefined, 'trpc'],
    ['', 'trpc'],
    ['trpc', 'trpc'],
    ['api', 'api'],
  ])('%j -> %j', (value, profile) => {
    expect(served.resolveProfile(value)).toBe(profile);
  });

  it.each(['API', 'Trpc', ' api', 'route', 'all'])('%j is not a profile', (value) => {
    expect(served.resolveProfile(value)).toBeNull();
  });
});

describe('servedPages', () => {
  const manifest = {
    '/api/trpc/[trpc]': 'a.js',
    '/api/v1/models': 'b.js',
    '/api/auth/session': 'c.js',
    '/api/webhooks/x': 'd.js',
  };

  it('trpc: the fixed list, whatever the manifest holds', () => {
    expect(served.servedPages('trpc', manifest)).toEqual([
      '/api/trpc/[trpc]',
      '/api/internal/image-delivery/[id]',
      '/api/internal/ping',
      '/api/internal/pulse',
      '/api/track/batch',
      '/api/live',
      '/api/health',
      '/api/ready',
      '/api/readyz',
      '/api/metrics',
    ]);
  });

  // /api/auth/ is deliberately NOT in the api profile: little CPU, and the widest blast radius
  // (cookies, redirects, POSTs) of anything the pools serve.
  it('api: the trpc list plus the manifest pages under /api/v1/, and no /api/auth/ page', () => {
    expect(served.servedPages('api', manifest)).toEqual([...served.TRPC_PAGES, '/api/v1/models']);
    expect(served.API_PROFILE_PREFIXES).toEqual(['/api/v1/']);
  });

  it('throws on an unknown profile rather than serving a default', () => {
    expect(() => served.servedPages('nope', manifest)).toThrow(/unknown standalone server profile/);
  });
});
