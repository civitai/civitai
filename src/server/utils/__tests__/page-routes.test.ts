import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  __resetPageRoutesForTest,
  PAGE_ROUTE_NONE,
  PAGE_ROUTE_OTHER,
  pageRouteLabel,
  pagesManifestPath,
  readPageRoutes,
} from '~/server/utils/page-routes';
import { usePagesManifestFixture } from './pages-manifest.fixture';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetPageRoutesForTest();
});

describe('readPageRoutes', () => {
  it('keeps page routes and the error page, and drops API and other internal `/_*` entries', () => {
    const distDir = usePagesManifestFixture();
    expect([...readPageRoutes(path.join(distDir, 'server', 'pages-manifest.json'))].sort()).toEqual(
      ['/', '/404', '/_error', '/images', '/models/[id]/[[...slug]]', '/user/[username]'].sort()
    );
  });

  it('defaults to the build directory Next serves from (dev builds under `dev/`)', () => {
    vi.stubEnv('NEXT_DIST_DIR', '');
    expect(pagesManifestPath('production')).toBe(
      path.resolve(process.cwd(), '.next/server/pages-manifest.json')
    );
    expect(pagesManifestPath('development')).toBe(
      path.resolve(process.cwd(), '.next/dev/server/pages-manifest.json')
    );
    vi.stubEnv('NODE_ENV', 'development');
    expect(pagesManifestPath()).toBe(
      path.resolve(process.cwd(), '.next/dev/server/pages-manifest.json')
    );
  });

  it('returns an empty set, without throwing, for a missing or malformed manifest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-manifest-bad-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    expect(readPageRoutes(path.join(dir, 'absent.json')).size).toBe(0);
    expect(readPageRoutes(path.join(dir, 'bad.json')).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('pageRouteLabel', () => {
  it('passes route patterns from the build manifest through unchanged', () => {
    usePagesManifestFixture();
    expect(pageRouteLabel('/')).toBe('/');
    expect(pageRouteLabel('/models/[id]/[[...slug]]')).toBe('/models/[id]/[[...slug]]');
    expect(pageRouteLabel(['/images', '/user/[username]'])).toBe('/images');
  });

  it('buckets a missing value as "none"', () => {
    usePagesManifestFixture();
    expect(pageRouteLabel(undefined)).toBe(PAGE_ROUTE_NONE);
    expect(pageRouteLabel(null)).toBe(PAGE_ROUTE_NONE);
    expect(pageRouteLabel('')).toBe(PAGE_ROUTE_NONE);
  });

  it('buckets concrete URLs, API and internal entries, and invented patterns as "other"', () => {
    usePagesManifestFixture();
    for (const raw of [
      '/models/12345/some-slug',
      '/models/[id]/[[...slug]]?x=1',
      '/models/[id]/[[...slug]]/',
      '/api/trpc/[trpc]',
      '/_app',
      '/not-a-page/[id]',
      'x'.repeat(10_000),
    ]) {
      expect(pageRouteLabel(raw)).toBe(PAGE_ROUTE_OTHER);
    }
  });

  it('labels every route "other", and warns once, when the manifest cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('NEXT_DIST_DIR', path.join(os.tmpdir(), 'no-such-build-dir'));
    __resetPageRoutesForTest();
    expect(pageRouteLabel('/')).toBe(PAGE_ROUTE_OTHER);
    expect(pageRouteLabel('/models/[id]/[[...slug]]')).toBe(PAGE_ROUTE_OTHER);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the manifest once, not per lookup', () => {
    const distDir = usePagesManifestFixture();
    const read = vi.spyOn(fs, 'readFileSync');
    pageRouteLabel('/');
    pageRouteLabel('/images');
    pageRouteLabel('/nope');
    expect(read.mock.calls.filter(([p]) => String(p).startsWith(distDir))).toHaveLength(1);
  });
});
