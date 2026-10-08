import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// isProd is read at module load and is false under vitest, which would let every guard through.
vi.mock('~/env/other', () => ({
  isProd: true,
  isDev: false,
  isTest: false,
  isPreview: false,
}));

function requestFor(url: string) {
  const nextUrl = new URL(url);
  const headers: Record<string, string> = { host: nextUrl.hostname };
  return {
    nextUrl,
    url,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as never;
}

async function redirectedTo(url: string) {
  const { routeGuardsMiddleware } = await import('~/server/middleware/route-guards.middleware');
  const request = requestFor(url);
  if (routeGuardsMiddleware.shouldRun && !routeGuardsMiddleware.shouldRun(request)) return null;
  let target: string | null = null;
  await routeGuardsMiddleware.handler({
    request,
    redirect: ((to: string) => {
      target = to;
      return { status: 307 } as never;
    }) as never,
  });
  return target;
}

beforeEach(() => {
  vi.resetModules();
});

describe('banking-change notice send route in production', () => {
  it('POSITIVE CONTROL: the same route under /api/testing is redirected away', async () => {
    expect(
      await redirectedTo('https://civitai.com/api/testing/banking-change-notice?token=abc')
    ).toBe('/');
  });

  it('has its handler under /api/admin and not under /api/testing', () => {
    const pages = path.join(__dirname, '../../../pages/api');
    expect(existsSync(path.join(pages, 'admin/banking-change-notice.ts'))).toBe(true);
    expect(existsSync(path.join(pages, 'testing/banking-change-notice.ts'))).toBe(false);
  });

  it('is reachable under /api/admin', async () => {
    expect(
      await redirectedTo('https://civitai.com/api/admin/banking-change-notice?token=abc')
    ).toBeNull();
  });
});
