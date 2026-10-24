/**
 * The SSR seeds `_app.getInitialProps` computes must reach `pageProps`.
 *
 * A seed is only useful if it gets from the server render to the `AppProvider` query it primes.
 * One that is computed but left out of the returned `pageProps` fails silently: the provider is
 * handed `undefined`, skips its seed, and the client fetches the query on every page load — the
 * exact request the seed exists to remove — while every unit test of the seed's VALUE stays
 * green. `chatSettings` shipped that way and `chat.getUserSettings` kept firing on every
 * signed-in page load.
 *
 * So this pins the relationship, not a value: one fixture in which every bootstrap member is
 * present and distinct, and a ledger of the seed keys `MyApp` hands to `AppProvider` (or a
 * sibling provider), each asserted present. The ledger is hand-kept: a NEW seed is covered only
 * once it is added to `SEED_PROPS`.
 *
 * Mocks mirror `app-settings-bootstrap.test.ts`, which owns the cookie/degraded behaviour.
 */
import type * as CookiesNext from 'cookies-next';
import type { AppContext } from 'next/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_SETTINGS } from '~/server/schema/chat.schema';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const h = vi.hoisted(() => ({
  jar: {} as Record<string, string>,
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
}));

vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<typeof CookiesNext>()),
  getCookie: vi.fn(() => 'dark'),
  getCookies: vi.fn(() => h.jar),
  deleteCookie: vi.fn(),
}));

// The real `getFeatureFlagsAsync` opens a Flipt client; the flag values are irrelevant here.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));

// Wholesale on purpose: `_app` uses only this export, and the real module pulls the database,
// redis and the server env into a test about what `getInitialProps` returns.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));

// Module scope on purpose: this graph is ~1200 modules (see app-settings-bootstrap.test.ts).
import AppWithTRPC from '~/pages/_app';

const getInitialProps = (
  AppWithTRPC as unknown as {
    getInitialProps: (c: AppContext) => Promise<{ pageProps: Record<string, unknown> }>;
  }
).getInitialProps;

function makeCtx(): AppContext {
  const noop = () => null;
  return {
    Component: noop,
    AppTree: noop,
    router: {},
    ctx: {
      req: { headers: { host: 'civitai.com' }, url: '/' },
      pathname: '/',
      query: {},
      AppTree: noop,
    },
  } as unknown as AppContext;
}

// Distinct from `DEFAULT_CHAT_SETTINGS` in every key, so a seed that fell back to the default
// (rather than the user's stored settings) cannot pass the equality below.
const STORED_CHAT = {
  muteSounds: true,
  replaceBadWords: true,
  acknowledged: true,
  dmPolicy: 'mutuals' as const,
  holdNewAccounts: true,
};

const session = { user: { id: 42, username: 'seeded' } };
const fullBootstrap = {
  session,
  settings: { features: {}, chat: STORED_CHAT },
  tosMeta: { hash: 'h', baseline: 'b', fieldKeys: {} },
  announcements: { domain: 'blue', items: [] },
  following: [7, 8],
  browsingSettingsAddons: [],
  liveNow: true,
  navBanners: [],
};

/**
 * The pageProps keys `MyApp` passes into a query seed, as of this writing — add new seeds here. Each one is derived from data the
 * bootstrap above already carries, so with this fixture every one of them must be defined.
 */
const SEED_PROPS = [
  'settings',
  'tosMeta',
  'announcements',
  'navBanners',
  'following',
  'liveNow',
  'browsingSettingsAddons',
  'userFeatureFlags',
  'chatSettings',
] as const;

beforeEach(() => {
  h.bootstrap.mockReset();
  h.jar = { '__Secure-civ-token': 'token-value' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});

describe('_app getInitialProps — SSR seeds reach pageProps', () => {
  it('returns every seed it computes for a signed-in render', async () => {
    h.bootstrap.mockResolvedValue(fullBootstrap);

    const { pageProps } = await getInitialProps(makeCtx());

    // Positive control: this is the signed-in path, not a degraded render with nothing to seed.
    expect(pageProps.session).toMatchObject(session);
    const missing = SEED_PROPS.filter((key) => pageProps[key] === undefined);
    expect(missing, 'seeds computed by getInitialProps but not returned in pageProps').toEqual([]);
  });

  it("seeds chat.getUserSettings with the user's stored chat settings", async () => {
    h.bootstrap.mockResolvedValue(fullBootstrap);

    const { pageProps } = await getInitialProps(makeCtx());

    expect(pageProps.chatSettings).toEqual(STORED_CHAT);
    expect(pageProps.chatSettings).not.toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it("seeds the resolver's default when the user has no stored chat settings", async () => {
    h.bootstrap.mockResolvedValue({ ...fullBootstrap, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(pageProps.chatSettings).toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it('does not seed chat settings for an anonymous render', async () => {
    h.jar = {};
    h.bootstrap.mockResolvedValue({ ...fullBootstrap, session: null });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(pageProps.session).toBeNull();
    expect(pageProps.chatSettings).toBeUndefined();
  });

  it('does not seed chat settings when the bootstrap degrades', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.bootstrap.mockRejectedValue(new Error('settings bootstrap timed out after 8000ms'));
    try {
      const { pageProps } = await getInitialProps(makeCtx());
      expect(pageProps.chatSettings).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
