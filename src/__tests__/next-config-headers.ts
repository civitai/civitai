import loadCustomRoutes from 'next/dist/lib/load-custom-routes';
import { buildCustomRoute } from 'next/dist/server/lib/router-utils/filesystem';
import { vi } from 'vitest';
import { routerPathname } from '~/server/middleware/__tests__/next-proxy-matcher';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConfig = any;

/**
 * The REAL `next.config.mjs` export's `headers()` rules under `nodeEnv`, read through Next's own
 * pipeline: `loadCustomRoutes` (which calls `headers()` and adds the `i18n` locale prefix to every
 * source), `buildCustomRoute` (the matcher the router builds from each rule), and the router's
 * locale-prefixed pathname. A text scan of the config would pass on a rule that never reaches Next.
 *
 * `headers()` reads NODE_ENV when `loadCustomRoutes` calls it, so the env is stubbed here; the caller
 * unstubs it (`vi.unstubAllEnvs()`).
 */
export async function loadNextConfigHeaders(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  const nextConfig = (await import('../../next.config.mjs')).default as AnyConfig;
  const { headers } = await loadCustomRoutes(nextConfig);
  const routes = headers.map((rule) => buildCustomRoute('header', rule));
  return {
    i18n: nextConfig.i18n,
    /**
     * Every header the rules matching `url` set, in rule order, as `resolve-routes.js` applies them
     * (in turn: a later value of a key replaces an earlier one).
     */
    matchedHeaders(url: string): { key: string; value: string }[] {
      const pathname = routerPathname(url, { i18n: nextConfig.i18n });
      const out: { key: string; value: string }[] = [];
      for (const route of routes) {
        if (route.match(pathname) === false) continue;
        for (const header of route.headers) out.push({ key: header.key, value: header.value });
      }
      return out;
    },
  };
}
