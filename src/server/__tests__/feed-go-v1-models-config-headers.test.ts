import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadNextConfigHeaders } from '~/__tests__/next-config-headers';

/**
 * The headers next.config.mjs's `headers()` give `GET /api/v1/models` and `/api/v1/models/[id]` in a
 * production build. The router sets them before the route runs (and the standalone server applies
 * the same routes manifest), so they are on every answer of these routes. feed-go writes them on
 * every answer it serves there, from apps/feed-go/internal/v1models/configheaders.json: this test
 * holds that file to the real config, read through Next's own pipeline (loadNextConfigHeaders, shared
 * with static-asset-cache-headers.test.ts).
 */

const CONFIG_HEADERS = join(process.cwd(), 'apps/feed-go/internal/v1models/configheaders.json');

afterEach(() => {
  vi.unstubAllEnvs();
});

const prod = await loadNextConfigHeaders('production');
vi.unstubAllEnvs();

/** The headers the router sets on `url`: each key once, at its first position, with its last value. */
function resolved(url: string) {
  const out = new Map<string, string>();
  for (const { key, value } of prod.matchedHeaders(url)) out.set(key, value);
  return [...out].map(([key, value]) => ({ key, value }));
}

describe('feed-go /api/v1/models: next.config headers', () => {
  it('POSITIVE CONTROL: the pipeline sees a rule the config has', () => {
    expect(resolved('/sitemap.xml')).toEqual(
      expect.arrayContaining([{ key: 'X-Robots-Tag', value: 'noindex' }])
    );
  });

  // The REST model routes write them on every answer; every route below also writes them on the 451
  // it answers a blocked region with (FEED_GO_ANSWER_REGION_BLOCKED).
  it.each([
    '/api/v1/models',
    '/api/v1/models?limit=2',
    '/api/v1/models/123',
    '/api/v1/images?limit=2',
    '/api/trpc/image.getImagesAsPostsInfinite',
    '/api/trpc/image.getInfinite',
    '/api/trpc/model.getAll',
  ])('%s gets exactly configheaders.json', (url) => {
    const { headers } = JSON.parse(readFileSync(CONFIG_HEADERS, 'utf8')) as {
      headers: { key: string; value: string }[];
    };
    expect(headers.length).toBeGreaterThan(0);
    expect(resolved(url)).toEqual(headers);
  });
});
