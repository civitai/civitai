import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The pages the standalone tRPC server answers (`scripts/trpc-server/served-pages.cjs`), matched
 * the way `server.cjs` matches them (`createPageMatcher` over that list). Expectations are
 * literals. Whether each served page answers the way Next does is the parity job's question
 * (`.github/workflows/trpc-server-parity.yml`); this pins WHICH paths reach a route module at all.
 */

const require = createRequire(import.meta.url);
const SERVED_PAGES: string[] = require('../served-pages.cjs');
const compat = require('../next-compat.cjs');
const match = compat.createPageMatcher(SERVED_PAGES);

const BEACONS = ['/api/internal/ping', '/api/internal/pulse', '/api/track/batch'];

describe('served pages', () => {
  // The whole list, so it fails when a page is added OR removed without this file changing too.
  it('is exactly these pages', () => {
    expect([...SERVED_PAGES]).toEqual([
      '/api/trpc/[trpc]',
      '/api/internal/image-delivery/[id]',
      '/api/internal/ping',
      '/api/internal/pulse',
      '/api/track/batch',
      '/api/live',
      '/api/health',
      '/api/ready',
      '/api/metrics',
    ]);
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(SERVED_PAGES)).toBe(true);
  });
});

describe('the beacon paths', () => {
  it.each(BEACONS)('%s reaches its own route module', (path) => {
    expect(match(path)).toEqual({ page: path });
  });

  // Next 308s a trailing slash and renders its 404 page for the rest; this server answers its
  // plain 404 (the parity job pins both answers). None of these may reach a beacon's handler.
  it.each([
    '/api/internal/ping/',
    '/api/internal/ping/x',
    '/api/internal/pings',
    '/api/internal/pulse/',
    '/api/internal/pulse/x',
    '/api/track/batch/',
    '/api/track/batch/x',
    '/api/track/batches',
    '/en/api/track/batch',
    '/api/internal',
    '/api/track',
  ])('%s is not served', (path) => {
    expect(match(path)).toEqual({ notFound: true });
  });

  // The beacons next to them in the same directories stay on Next: only these three move.
  it.each([
    '/api/track/block-render',
    '/api/track/block-event',
    '/api/track/block-message',
    '/api/internal/activity',
    '/api/internal/image-delivery',
  ])('the neighbouring route %s is not served', (path) => {
    expect(match(path)).toEqual({ notFound: true });
  });
});

describe('the routes that were already served', () => {
  it.each([
    ['/api/trpc/a.b,c.d', '/api/trpc/[trpc]'],
    ['/api/internal/image-delivery/abc', '/api/internal/image-delivery/[id]'],
    ['/api/live', '/api/live'],
    ['/api/health', '/api/health'],
    ['/api/ready', '/api/ready'],
    ['/api/metrics', '/api/metrics'],
  ])('%s is still served by %s', (path, page) => {
    expect(match(path)).toEqual({ page });
  });

  it.each(['/', '/api', '/api/v1/images', '/models/1', '/api/internal/image-delivery/a/b'])(
    'an unknown path %s is still a 404',
    (path) => {
      expect(match(path)).toEqual({ notFound: true });
    }
  );
});
