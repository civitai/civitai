import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { PAGE_ROUTES } from '~/server/utils/page-routes.list';
import { PAGE_ROUTE_NONE, PAGE_ROUTE_OTHER, pageRouteLabel } from '~/server/utils/page-routes';

const PAGES_DIR = path.resolve(__dirname, '../../../pages');
const PAGE_FILE = /\.(tsx|ts|jsx|js)$/;
const NOT_ROUTES = new Set(['/_app', '/_document']);

function routesOnDisk(dir = PAGES_DIR): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === path.join(PAGES_DIR, 'api')) continue;
      routes.push(...routesOnDisk(full));
    } else if (PAGE_FILE.test(entry.name)) {
      const route =
        '/' +
        path
          .relative(PAGES_DIR, full)
          .replace(PAGE_FILE, '')
          .replace(/(^|\/)index$/, '');
      const normalised = route === '/' ? '/' : route.replace(/\/$/, '');
      if (!NOT_ROUTES.has(normalised)) routes.push(normalised);
    }
  }
  return routes;
}

describe('PAGE_ROUTES', () => {
  it('matches the pages on disk exactly (a missing page would be counted as "other")', () => {
    const onDisk = routesOnDisk().sort();
    expect(onDisk.length).toBeGreaterThan(100);
    const expected = `[\n${onDisk.map((r) => `  '${r}',`).join('\n')}\n]`;
    expect(
      [...PAGE_ROUTES].sort(),
      `Update src/server/utils/page-routes.list.ts to:\n${expected}`
    ).toEqual(onDisk);
  });
});

describe('pageRouteLabel', () => {
  it('passes known route patterns through unchanged', () => {
    expect(pageRouteLabel('/')).toBe('/');
    expect(pageRouteLabel('/models/[id]/[[...slug]]')).toBe('/models/[id]/[[...slug]]');
    expect(pageRouteLabel(['/images', '/models'])).toBe('/images');
  });

  it('buckets a missing header as "none"', () => {
    expect(pageRouteLabel(undefined)).toBe(PAGE_ROUTE_NONE);
    expect(pageRouteLabel(null)).toBe(PAGE_ROUTE_NONE);
    expect(pageRouteLabel('')).toBe(PAGE_ROUTE_NONE);
  });

  it('buckets concrete URLs and invented patterns as "other"', () => {
    for (const raw of [
      '/models/12345/some-slug',
      '/models/[id]/[[...slug]]?x=1',
      '/models/[id]/[[...slug]]/',
      '/not-a-page/[id]',
      '/MODELS',
      'x'.repeat(10_000),
    ]) {
      expect(pageRouteLabel(raw)).toBe(PAGE_ROUTE_OTHER);
    }
  });
});
