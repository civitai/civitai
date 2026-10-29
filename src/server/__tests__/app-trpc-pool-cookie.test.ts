/**
 * `_app.getInitialProps` keeps the tRPC routing cookie (`civ-trpc-pool`) in step with the
 * viewer's `trpcPoolRoute` flag on a full render: set for a signed-in viewer the flag is on for,
 * cleared once it is off, never set for an anonymous viewer or on a response already marked
 * cacheable, and left alone when the settings bootstrap could not say who the viewer is.
 *
 * The flag mock answers `true` for EVERY evaluation, with or without a user, so a case where the
 * cookie is not set is decided by `_app`, not by the flag.
 *
 * Lives outside `src/pages` deliberately: Next treats every file under there as a route.
 */
import type { ServerResponse } from 'node:http';
import type { AppContext } from 'next/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';

const h = vi.hoisted(() => ({
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
  flagOn: { current: true },
}));

// Wholesale on purpose, as in app-settings-bootstrap.test.ts: `_app` uses only this export.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => (h.flagOn.current ? { trpcPoolRoute: true } : {})),
}));

import AppWithTRPC from '~/pages/_app';

const getInitialProps = (
  AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => Promise<unknown> }
).getInitialProps;

const SIGNED_IN = { session: { user: { id: 4242, username: 'trpc-pool-viewer' } } };
const ANONYMOUS = { session: null };

const SET =
  'civ-trpc-pool=1; Path=/; Domain=civitai.com; Max-Age=604800; Secure; HttpOnly; SameSite=Lax';
const CLEAR =
  'civ-trpc-pool=; Path=/; Domain=civitai.com; Max-Age=0; Secure; HttpOnly; SameSite=Lax';

async function render({
  cookie,
  preset = {},
}: { cookie?: string; preset?: Record<string, string> } = {}) {
  const url = '/models';
  const { req, res } = createRealApiPair({
    url,
    headers: { host: 'civitai.com', ...(cookie ? { cookie } : {}) },
  });
  // `createRealApiPair` gives the request a parsed jar; a page request carries only the header.
  delete (req as unknown as { cookies?: unknown }).cookies;
  const response = res as unknown as ServerResponse;
  for (const [name, value] of Object.entries(preset)) response.setHeader(name, value);
  const noop = () => null;
  await getInitialProps({
    Component: noop,
    AppTree: noop,
    router: {},
    ctx: { req, res, pathname: url, query: {}, asPath: url, AppTree: noop },
  } as unknown as AppContext);
  return ([] as unknown[]).concat(response.getHeader('Set-Cookie') ?? []).map(String);
}

const poolCookies = (all: string[]) => all.filter((c) => c.startsWith('civ-trpc-pool='));

beforeEach(() => {
  h.bootstrap.mockReset();
  h.flagOn.current = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});

describe('_app: the tRPC routing cookie follows the viewer flag', () => {
  it('signed in, flag on: sets it with the exact attributes', async () => {
    h.bootstrap.mockImplementation(async () => SIGNED_IN);
    expect(poolCookies(await render({ cookie: '__Secure-civ-token=t' }))).toEqual([SET]);
  });

  it('signed in, flag off, cookie present: clears it', async () => {
    h.bootstrap.mockImplementation(async () => SIGNED_IN);
    h.flagOn.current = false;
    const cookie = '__Secure-civ-token=t; civ-trpc-pool=1';
    expect(poolCookies(await render({ cookie }))).toEqual([CLEAR]);
  });

  it('anonymous, flag on for everyone: never set', async () => {
    h.bootstrap.mockImplementation(async () => ANONYMOUS);
    expect(poolCookies(await render())).toEqual([]);
  });

  it('anonymous, cookie left from a signed-in visit: cleared', async () => {
    h.bootstrap.mockImplementation(async () => ANONYMOUS);
    expect(poolCookies(await render({ cookie: 'civ-trpc-pool=1' }))).toEqual([CLEAR]);
  });

  it('a response already marked cacheable: never set', async () => {
    h.bootstrap.mockImplementation(async () => SIGNED_IN);
    const all = await render({
      cookie: '__Secure-civ-token=t',
      preset: { 'Cache-Control': 'public, max-age=60' },
    });
    expect(poolCookies(all)).toEqual([]);
  });

  it('a degraded bootstrap (viewer unknown): left as it is', async () => {
    h.bootstrap.mockImplementation(async () => {
      throw new Error('bootstrap down');
    });
    h.flagOn.current = false;
    const cookie = '__Secure-civ-token=t; civ-trpc-pool=1';
    expect(poolCookies(await render({ cookie }))).toEqual([]);
  });
});
