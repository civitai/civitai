import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import loadCustomRoutes from 'next/dist/lib/load-custom-routes';
import { buildCustomRoute } from 'next/dist/server/lib/router-utils/filesystem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routerPathname } from '~/server/middleware/__tests__/next-proxy-matcher';

/**
 * The headers next.config.mjs's `headers()` give `GET /api/v1/models` and `/api/v1/models/[id]` in a
 * production build. The router sets them before the route runs (and the standalone server applies
 * the same routes manifest), so they are on every answer of these routes. feed-go writes them on
 * every answer it serves there, from apps/feed-go/internal/v1models/configheaders.json: this test
 * holds that file to the real config, read through Next's own pipeline (`loadCustomRoutes`, the
 * router's matcher, the locale-prefixed pathname), as static-asset-cache-headers.test.ts reads it.
 */

const CONFIG_HEADERS = join(process.cwd(), 'apps/feed-go/internal/v1models/configheaders.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConfig = any;

async function configHeadersFor(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  const nextConfig = (await import('../../../next.config.mjs')).default as AnyConfig;
  const { headers } = await loadCustomRoutes(nextConfig);
  const routes = headers.map((rule) => buildCustomRoute('header', rule));
  /** Every header Next's custom headers give `url`, in order, a later value of a key replacing it. */
  return (url: string) => {
    const pathname = routerPathname(url, { i18n: nextConfig.i18n });
    const out = new Map<string, string>();
    for (const route of routes) {
      if (route.match(pathname) === false) continue;
      for (const header of route.headers) {
        out.delete(header.key);
        out.set(header.key, header.value);
      }
    }
    return [...out].map(([key, value]) => ({ key, value }));
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const prod = await configHeadersFor('production');
vi.unstubAllEnvs();

describe('feed-go /api/v1/models: next.config headers', () => {
  it('POSITIVE CONTROL: the pipeline sees a rule the config has', () => {
    expect(prod('/sitemap.xml')).toEqual(
      expect.arrayContaining([{ key: 'X-Robots-Tag', value: 'noindex' }])
    );
  });

  it.each(['/api/v1/models', '/api/v1/models?limit=2', '/api/v1/models/123'])(
    '%s gets exactly configheaders.json',
    (url) => {
      const { headers } = JSON.parse(readFileSync(CONFIG_HEADERS, 'utf8')) as {
        headers: { key: string; value: string }[];
      };
      expect(headers.length).toBeGreaterThan(0);
      expect(prod(url)).toEqual(headers);
    }
  );
});
