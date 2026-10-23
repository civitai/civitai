// @vitest-environment happy-dom
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { getCookies } from 'cookies-next';
import type * as NextRouterModule from 'next/router';
import type { ComponentType, ReactNode } from 'react';
import { act, createElement as h, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as DeviceHelpersModule from '~/utils/device-helpers';
import type * as PrivacyUiModule from '~/components/Consent/privacy-ui';

/**
 * The shell boot (`useShellBootstrap` + the providers' shell paths), driven through the real
 * providers `_app` wires it into, on the REAL tRPC client with only `fetch` stubbed: every request
 * a run makes is counted, and every cache entry is read under tRPC's own keys.
 *
 * `ShellApp` below is `_app`'s wiring reduced to those providers. That it matches `_app` is pinned
 * by `src/tests/pages/app-shell-wiring.test.ts`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = {
  asPath: '/images/101',
  query: {} as Record<string, string>,
  pathname: '/images/[imageId]',
};
vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<typeof NextRouterModule>()),
  useRouter: () => router,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsModule>()),
  useBrowsingSettings: (select: (s: { allowAds: boolean }) => unknown) =>
    select({ allowAds: true }),
}));
vi.mock('~/utils/device-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceHelpersModule>()),
  isBraveBrowser: async () => false,
}));
// Its real module opens the signals worker; only the ad-impression tracker reads it.
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalContext: () => ({ worker: null }),
}));
vi.mock('~/components/Consent/privacy-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof PrivacyUiModule>()),
  detectPrivacyUi: () => undefined,
}));
/** Every ad script `AdsProvider` has Next load, by id or src. Inline ones run, as Next runs them. */
const { adScripts } = vi.hoisted(() => ({ adScripts: [] as string[] }));
vi.mock('next/script', async () => {
  const { useEffect } = await import('react');
  return {
    default: function ScriptRecorder(props: {
      id?: string;
      src?: string;
      dangerouslySetInnerHTML?: { __html: string };
    }) {
      useEffect(() => {
        adScripts.push(props.id ?? props.src ?? '(anonymous)');
        if (props.dangerouslySetInnerHTML) new Function(props.dangerouslySetInnerHTML.__html)();
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    },
  };
});

const { trpc, queryClient } = await import('~/utils/trpc');
const { AppProvider, useAppContext } = await import('~/providers/AppProvider');
const { SessionProvider, useSession } = await import('~/providers/SessionProvider');
const { FeatureFlagsProvider, useFeatureFlags, useFeatureFlagsReady } = await import(
  '~/providers/FeatureFlagsProvider'
);
const { ThirdPartyConsentProvider } = await import(
  '~/components/Consent/ThirdPartyConsentProvider'
);
const { useThirdPartyConsent } = await import('~/components/Consent/consent.context');
const { CivitaiSessionProvider, useCivitaiSessionContext } = await import(
  '~/components/CivitaiWrapped/CivitaiSessionProvider'
);
const { IsClientProvider } = await import('~/providers/IsClientProvider');
const { ReferralsProvider } = await import('~/components/Referrals/ReferralsProvider');
const { AdsProvider, useAdsContext } = await import('~/components/Ads/AdsProvider');
const { ShellBootstrapProvider, useShellBootstrap, useShellReady } = await import(
  '~/components/Shell/ShellBootstrapProvider'
);
const { shellNavigation } = await import('~/components/Shell/shell-page-data');
const { parseCookies } = await import('~/shared/utils/cookies');
const { clientTransformer } = await import('~/shared/utils/trpc-union-transformer');

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

const OWNER = {
  id: 7,
  username: 'owner',
  isModerator: false,
  tier: 'free',
  createdAt: '2024-01-02T03:04:05.000Z',
};
const SESSION = { user: OWNER, expires: '2026-11-21T00:00:00.000Z' };
const SETTINGS = {
  features: { chat: false },
  chat: { muteSounds: true, acknowledged: true },
  allowAds: true,
  disableHidden: false,
};
const FOLLOWING = [11, 12];
const CHAT_SETTINGS = { muteSounds: true, replaceBadWords: false, acknowledged: true };
const NAV_BANNERS = [{ id: 'event:fixture', title: 'Fixture event', href: '/events/fixture' }];
// The overlay overrides one host flag (`chat`), so a merge in the wrong order shows.
const FLAGS = { shellImages: true, canViewNsfw: false, chat: true };
const USER_FLAGS = { chat: false, fixtureToggle: true };
const TEXAS = { countryCode: 'US', regionCode: 'TX', fullLocationCode: 'US:TX' };
const CALIFORNIA = { countryCode: 'US', regionCode: 'CA', fullLocationCode: 'US:CA' };
const IMAGE = { id: 101, nsfwLevel: 4, userId: 7, createdAt: new Date('2025-05-06T07:08:09.000Z') };

const imageKey = getQueryKey(trpc.image.get, { id: 101 }, 'query');

/** `trpcState` as `createServerSideProps` dehydrates it: the server transformer's serialize. */
function trpcStateFor(image: typeof IMAGE) {
  const qc = new QueryClient();
  qc.setQueryData(imageKey, image);
  return JSON.parse(JSON.stringify(clientTransformer.output.serialize(dehydrate(qc))));
}

/** A 200 body shaped like `GET /api/page-data/images/[imageId]`'s (`ShellPageData`). */
function payload(over: Record<string, unknown> = {}) {
  return {
    session: SESSION,
    settings: SETTINGS,
    tosMeta: { hash: 'h', baseline: 'b', fieldKeys: {} },
    following: FOLLOWING,
    liveNow: true,
    navBanners: NAV_BANNERS,
    flags: FLAGS,
    userFeatureFlags: USER_FLAGS,
    chatSettings: CHAT_SETTINGS,
    region: TEXAS,
    adsGated: true,
    trpcState: trpcStateFor(IMAGE),
    ...over,
  };
}

const SERVER_DOMAINS = {
  green: { primary: 'civitai.green', aliases: [] },
  blue: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: [] },
};

/** The props a static-shell server render hands `_app`: nothing viewer-dependent. */
function shellPageProps(over: Record<string, unknown> = {}) {
  return {
    shell: true,
    cookies: parseCookies({}),
    hasAuthCookie: true,
    flags: { shellImages: true },
    liveNow: true,
    verifiedBot: null,
    ...over,
  };
}

/** The props a full server render of the same page hands `_app` for the same viewer. */
function fullRenderPageProps(data: ReturnType<typeof payload>) {
  return {
    session: data.session,
    cookies: parseCookies(getCookies()),
    hasAuthCookie: true,
    flags: data.flags,
    userFeatureFlags: data.userFeatureFlags,
    settings: data.settings,
    following: data.following,
    chatSettings: data.chatSettings,
    navBanners: data.navBanners,
    liveNow: data.liveNow,
    region: data.region,
    verifiedBot: null,
    adsGated: data.adsGated,
    trpcState: data.trpcState,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────

type Observed = {
  session: unknown;
  sessionStatus: string;
  flags: Record<string, unknown>;
  flagsReady: boolean;
  region: unknown;
  verifiedBot: unknown;
  regionPending: unknown;
  consent: { required: boolean; allowed: boolean; consent: unknown };
  consentCookie: unknown;
  disableHidden: boolean;
  adsGated: boolean;
  shellReady: boolean;
};

/** Every committed render's view, in order. */
const commits: Observed[] = [];
const last = () => commits[commits.length - 1];
/** `useAdsContext().adsEnabled` at every commit: what decides whether an ad slot renders. */
const adsEnabledCommits: boolean[] = [];

function AdsReader() {
  const { adsEnabled } = useAdsContext();
  useEffect(() => {
    adsEnabledCommits.push(adsEnabled);
  });
  return null;
}

function ImageConsumer() {
  trpc.image.get.useQuery({ id: 101 });
  return null;
}

function Probe({
  adsGated,
  consentCookie,
  withAds,
}: {
  adsGated: boolean;
  consentCookie: unknown;
  withAds: boolean;
}) {
  const session = useSession();
  const flags = useFeatureFlags();
  const flagsReady = useFeatureFlagsReady();
  const app = useAppContext();
  const consent = useThirdPartyConsent();
  const civitai = useCivitaiSessionContext();
  const shellReady = useShellReady();
  const view: Observed = {
    session: session.data,
    sessionStatus: session.status,
    flags,
    flagsReady,
    region: app.region,
    verifiedBot: app.verifiedBot,
    regionPending: app.regionPending,
    consent: { required: consent.required, allowed: consent.allowed, consent: consent.consent },
    consentCookie,
    disableHidden: civitai.settings.disableHidden,
    adsGated,
    shellReady,
  };
  useEffect(() => {
    commits.push(view);
  });
  // A shell page renders its content only once the shell is ready.
  return h('div', null, shellReady ? h(ImageConsumer) : null, withAds ? h(AdsReader) : null);
}

type PageProps = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** `_app`'s shell wiring, reduced to the providers it touches. */
function ShellApp({ pageProps, withAds = false }: { pageProps: PageProps; withAds?: boolean }) {
  const {
    session,
    cookies: pageCookies = parseCookies(getCookies()),
    flags,
    userFeatureFlags,
    settings,
    following,
    liveNow = false,
    chatSettings,
    navBanners,
    region,
    verifiedBot = null,
    hasAuthCookie: pageHasAuthCookie,
    adsGated: pageAdsGated = false,
    shell,
  } = pageProps;
  const [bootedShell] = useState(() => shell === true);
  const {
    cookies,
    hasAuthCookie,
    adsGated,
    sessionSeed,
    flagsSeed,
    appShell,
    referralsPending,
    status,
  } = useShellBootstrap(bootedShell, {
    onShellPage: shell === true,
    cookies: pageCookies,
    hasAuthCookie: pageHasAuthCookie,
    adsGated: pageAdsGated,
  });

  const probe = h(Probe, { adsGated, consentCookie: cookies.consent, withAds });
  const app = h(
    AppProvider,
    {
      seed: 1,
      canIndex: false,
      settings,
      following,
      liveNow,
      chatSettings,
      navBanners,
      region,
      domain: 'blue',
      host: 'civitai.com',
      serverDomains: SERVER_DOMAINS,
      availableOAuthProviders: [],
      verifiedBot,
      isAuthed: !!session || hasAuthCookie,
      shell: appShell,
    } as never,
    h(
      ThirdPartyConsentProvider,
      { initialConsent: cookies.consent, loggedIn: !!session || hasAuthCookie } as never,
      h(
        SessionProvider,
        {
          session: session ? session : !hasAuthCookie ? null : undefined,
          seed: sessionSeed,
          refetchOnWindowFocus: false,
        } as never,
        h(
          IsClientProvider,
          null,
          h(
            FeatureFlagsProvider,
            { flags, userFlags: userFeatureFlags, seed: flagsSeed } as never,
            h(
              CivitaiSessionProvider,
              { disableHidden: cookies.disableHidden } as never,
              h(
                ReferralsProvider,
                { ...cookies.referrals, pending: referralsPending } as never,
                withAds ? h(AdsProvider, { gated: adsGated } as never, probe) : probe
              )
            )
          )
        )
      )
    )
  );
  return status ? h(ShellBootstrapProvider, { status } as never, app) : app;
}

const Wrapped = trpc.withTRPC(ShellApp as never) as unknown as ComponentType<{
  pageProps: PageProps;
  withAds?: boolean;
}>;

// ── Transport ───────────────────────────────────────────────────────────────────────────────────

/** Every request the run made: path + query. */
const requests: string[] = [];
let pageDataAnswer: () => Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch() {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, 'http://localhost');
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname.startsWith('/api/page-data')) return pageDataAnswer();
      if (url.pathname === '/api/auth/session') return json({});
      return json({ error: 'unexpected request in test' }, 500);
    })
  );
}

const trpcRequests = () => requests.filter((r) => r.startsWith('/api/trpc'));

/** A `window.__civShell` the test resolves when it chooses. */
function deferredShell() {
  let resolve!: (res: Response) => void;
  window.__civShell = new Promise<Response>((r) => {
    resolve = r;
  });
  return resolve;
}

let root: Root | undefined;

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function render(pageProps: PageProps, { withAds = false, strict = false } = {}) {
  const tree: ReactNode = h(Wrapped, { pageProps, withAds });
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(strict ? h(StrictMode, null, tree) : tree);
  });
  await settle();
}

const cached = () => ({
  getSettings: queryClient.getQueryData(getQueryKey(trpc.user.getSettings, undefined, 'query')),
  getFeatureFlags: queryClient.getQueryData(
    getQueryKey(trpc.user.getFeatureFlags, undefined, 'query')
  ),
  getFollowingUsers: queryClient.getQueryData(
    getQueryKey(trpc.user.getFollowingUsers, undefined, 'query')
  ),
  chatGetUserSettings: queryClient.getQueryData(
    getQueryKey(trpc.chat.getUserSettings, undefined, 'query')
  ),
  getNavBanners: queryClient.getQueryData(
    getQueryKey(trpc.event.getNavBanners, undefined, 'query')
  ),
  imageGet: queryClient.getQueryData(imageKey),
});

function clearCookies() {
  for (const name of Object.keys(parseCookiesRaw()))
    document.cookie = `${name}=; Path=/; Max-Age=0`;
}
function parseCookiesRaw() {
  return Object.fromEntries(
    document.cookie
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => [c.split('=')[0], decodeURIComponent(c.split('=').slice(1).join('='))])
  );
}

let navigate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  queryClient.clear();
  commits.length = 0;
  adsEnabledCommits.length = 0;
  adScripts.length = 0;
  clearCookies();
  delete window.__civShell;
  window.history.replaceState(null, '', '/images/101');
  pageDataAnswer = async () => json(payload());
  stubFetch();
  navigate = vi.spyOn(shellNavigation, 'replace').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  navigate.mockRestore();
  vi.unstubAllGlobals();
  delete window.__civShell;
});

// ── Adoption ────────────────────────────────────────────────────────────────────────────────────

describe('a shell boot adopts the page data into the state a full render would have', () => {
  it('ends with the session, flags, region, adsGated and caches of a full render for the same viewer', async () => {
    document.cookie = 'civitai-consent=accepted; Path=/';
    const data = payload();

    await render(fullRenderPageProps(data));
    const fullRender = { view: last(), cache: cached(), trpc: trpcRequests() };
    act(() => root?.unmount());
    queryClient.clear();
    commits.length = 0;
    requests.length = 0;

    const resolve = deferredShell();
    await render(shellPageProps());
    resolve(json(data));
    await settle();
    const shell = { view: last(), cache: cached(), trpc: trpcRequests() };

    // `regionPending` is the one difference by design: a shell boot's context carries it.
    const { regionPending: shellRegionPending, ...shellView } = shell.view;
    const { regionPending: fullRegionPending, ...fullView } = fullRender.view;
    expect({ ...shell, view: shellView }).toEqual({ ...fullRender, view: fullView });
    expect(shellRegionPending).toBe(false);
    expect(fullRegionPending).toBeUndefined();
    // Pinned literally as well, so the equality cannot pass on two equally empty runs.
    expect(shellView).toEqual({
      session: SESSION,
      sessionStatus: 'authenticated',
      flags: { shellImages: true, canViewNsfw: false, chat: false, fixtureToggle: true },
      flagsReady: true,
      region: TEXAS,
      verifiedBot: null,
      consent: { required: false, allowed: true, consent: null },
      consentCookie: 'accepted',
      disableHidden: false,
      adsGated: true,
      shellReady: true,
    });
    expect(shell.cache).toEqual({
      getSettings: SETTINGS,
      getFeatureFlags: USER_FLAGS,
      getFollowingUsers: FOLLOWING,
      chatGetUserSettings: CHAT_SETTINGS,
      getNavBanners: NAV_BANNERS,
      imageGet: IMAGE,
    });
    // Revived by the client transformer, not left as the JSON string.
    expect((shell.cache.imageGet as typeof IMAGE).createdAt).toBeInstanceOf(Date);
    // Seeded before any query that reads them was enabled: nothing reached the network.
    expect(shell.trpc).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('holds every viewer-dependent value fail-closed until the page data arrives', async () => {
    deferredShell();
    await render(shellPageProps());

    expect(last()).toEqual({
      session: undefined,
      sessionStatus: 'loading',
      flags: { shellImages: true },
      flagsReady: false,
      region: undefined,
      verifiedBot: null,
      regionPending: true,
      consent: { required: false, allowed: false, consent: null },
      consentCookie: null,
      disableHidden: true,
      adsGated: true,
      shellReady: false,
    });
    // No session fetch, no settings / nav-banner fetch, no page-data fetch of its own.
    expect(requests).toEqual([]);
  });

  it('adopts an in-flight window.__civShell rather than fetching', async () => {
    window.__civShell = Promise.resolve(json(payload()));
    await render(shellPageProps());
    expect(last().shellReady).toBe(true);
    expect(requests).toEqual([]);
  });

  it('fetches /api/page-data with the page path and query when no request is in flight', async () => {
    window.history.replaceState(null, '', '/images/101?collectionId=5');
    await render(shellPageProps());
    expect(requests).toEqual(['/api/page-data/images/101?collectionId=5']);
    expect(last().shellReady).toBe(true);
  });

  it('a signed-out answer renders anonymous and does not fetch the session', async () => {
    window.__civShell = Promise.resolve(
      json(
        payload({
          session: null,
          settings: undefined,
          following: undefined,
          chatSettings: undefined,
          userFeatureFlags: undefined,
        })
      )
    );
    await render(shellPageProps());
    expect(last()).toMatchObject({
      session: null,
      sessionStatus: 'unauthenticated',
      flags: FLAGS,
      flagsReady: true,
    });
    expect(requests).toEqual([]);
  });
});

// ── Cookies ─────────────────────────────────────────────────────────────────────────────────────

describe('cookie-derived values on a shell boot', () => {
  it('are read after hydration, never during render', async () => {
    document.cookie = 'civitai-consent=rejected; Path=/';
    deferredShell();
    await render(shellPageProps());
    // The first commit renders the server's (empty) cookies, as hydration must; the jar is read
    // in an effect after it.
    expect(commits[0].consentCookie).toBeNull();
    expect(last().consentCookie).toBe('rejected');
  });

  it('do not overwrite the referral landing page before the cookies are read', async () => {
    document.cookie = 'ref_landing_page=%2Flanding; Path=/';
    window.__civShell = Promise.resolve(json(payload()));
    await render(shellPageProps());
    expect(last().shellReady).toBe(true);
    expect(parseCookiesRaw().ref_landing_page).toBe('/landing');
  });

  it('control: with no landing page cookie the provider does record one', async () => {
    window.__civShell = Promise.resolve(json(payload()));
    await render(shellPageProps());
    expect(parseCookiesRaw().ref_landing_page).toBe('/images/101');
  });
});

// ── Consent ─────────────────────────────────────────────────────────────────────────────────────

describe('consent on a shell boot fails closed until the region is known', () => {
  it('a consent-required region: closed while pending, then the gate, with the cookie decision', async () => {
    document.cookie = 'civitai-consent=rejected; Path=/';
    const resolve = deferredShell();
    await render(shellPageProps());
    expect(last().consent).toEqual({ required: false, allowed: false, consent: null });

    resolve(json(payload({ region: CALIFORNIA })));
    await settle();

    expect(last().consent).toEqual({ required: true, allowed: false, consent: 'rejected' });
    expect(commits.every((c) => !c.consent.allowed)).toBe(true);
  });

  it('a consent-required region with no cookie: a signed-in viewer has accepted', async () => {
    window.__civShell = Promise.resolve(json(payload({ region: CALIFORNIA })));
    await render(shellPageProps());
    expect(last().consent).toEqual({ required: true, allowed: true, consent: 'accepted' });
  });

  it('a region that needs no consent: closed while pending, then open', async () => {
    const resolve = deferredShell();
    await render(shellPageProps());
    expect(last().consent.allowed).toBe(false);

    resolve(json(payload({ region: TEXAS })));
    await settle();
    expect(last().consent).toEqual({ required: false, allowed: true, consent: null });
  });
});

// ── Ads ─────────────────────────────────────────────────────────────────────────────────────────

describe('ads on a shell boot', () => {
  let googletagPush: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    googletagPush = vi.fn();
    // The inline ad script reads it both as `window.googletag` and as a bare global.
    const googletag = { cmd: { push: googletagPush } };
    (window as unknown as { googletag: unknown }).googletag = googletag;
    (globalThis as unknown as { googletag: unknown }).googletag = googletag;
  });

  it('an R-rated image: no ad script and no googletag call before the verdict, and never a slot', async () => {
    const resolve = deferredShell();
    await render(shellPageProps(), { withAds: true });
    expect(adScripts).toEqual([]);
    expect(googletagPush).not.toHaveBeenCalled();
    expect(adsEnabledCommits.length).toBeGreaterThan(0);
    expect(adsEnabledCommits).not.toContain(true);

    resolve(json(payload({ adsGated: true })));
    await settle();

    expect(last()).toMatchObject({ shellReady: true, adsGated: true });
    expect(adsEnabledCommits).not.toContain(true);
    // After the verdict the loader mounts without a slot, as on a full render of a gated page —
    // which is also what shows the googletag spy can see a call.
    expect(adScripts).toContain('ad-cleanup');
    expect(googletagPush).toHaveBeenCalled();
  });

  it('control: a PG image enables ads once its verdict arrives, and not before', async () => {
    const resolve = deferredShell();
    await render(shellPageProps(), { withAds: true });
    expect(adsEnabledCommits).not.toContain(true);
    expect(adScripts).toEqual([]);

    resolve(json(payload({ adsGated: false })));
    await settle();

    expect(last()).toMatchObject({ shellReady: true, adsGated: false });
    expect(adsEnabledCommits[adsEnabledCommits.length - 1]).toBe(true);
    expect(adScripts).toContain('ad-cleanup');
  });
});

// ── Fallback ────────────────────────────────────────────────────────────────────────────────────

describe('a page-data answer other than 200 leaves the shell exactly once', () => {
  it.each([
    [404, '/images/101?civ-shell=0'],
    [500, '/images/101?civ-shell=0'],
    [503, '/images/101?civ-shell=0'],
    [451, '/region-blocked'],
  ])('%s → %s', async (status, to) => {
    window.history.replaceState(null, '', '/images/101');
    pageDataAnswer = async () => json({ error: 'x' }, status);
    await render(shellPageProps(), { strict: true });
    expect(navigate.mock.calls).toEqual([[to]]);
    expect(last().shellReady).toBe(false);
  });

  it('keeps the query string when it adds the bypass', async () => {
    window.history.replaceState(null, '', '/images/101?collectionId=5');
    pageDataAnswer = async () => json({}, 404);
    await render(shellPageProps());
    expect(navigate.mock.calls).toEqual([['/images/101?collectionId=5&civ-shell=0']]);
  });

  it('a network failure falls back like a 5xx', async () => {
    pageDataAnswer = async () => {
      throw new TypeError('Failed to fetch');
    };
    await render(shellPageProps());
    expect(navigate.mock.calls).toEqual([['/images/101?civ-shell=0']]);
  });

  it('a 200 that is not page data falls back like a 5xx', async () => {
    window.__civShell = Promise.resolve(json({ error: 'not page data' }));
    await render(shellPageProps());
    expect(navigate.mock.calls).toEqual([['/images/101?civ-shell=0']]);
  });

  it('does not reload a page that already carries the bypass: no loop', async () => {
    window.history.replaceState(null, '', '/images/101?civ-shell=0');
    pageDataAnswer = async () => json({}, 500);
    await render(shellPageProps());
    expect(navigate).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ shellReady: false, adsGated: true, flagsReady: false });
    expect(last().consent.allowed).toBe(false);
  });
});

// ── Inactive ────────────────────────────────────────────────────────────────────────────────────

describe('without pageProps.shell nothing of the shell runs', () => {
  it('makes no page-data request, never reads window.__civShell, and mounts no shell provider', async () => {
    let reads = 0;
    Object.defineProperty(window, '__civShell', {
      configurable: true,
      get: () => {
        reads += 1;
        return undefined;
      },
    });
    const data = payload();
    await render(fullRenderPageProps(data));

    expect(reads).toBe(0);
    expect(requests.filter((r) => r.startsWith('/api/page-data'))).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(last()).toEqual({
      session: SESSION,
      sessionStatus: 'authenticated',
      flags: { shellImages: true, canViewNsfw: false, chat: false, fixtureToggle: true },
      flagsReady: true,
      region: TEXAS,
      verifiedBot: null,
      regionPending: undefined,
      consent: { required: false, allowed: true, consent: null },
      consentCookie: null,
      disableHidden: false,
      adsGated: true,
      // No shell provider in the tree.
      shellReady: true,
    });
    Object.defineProperty(window, '__civShell', { configurable: true, value: undefined });
  });

  it('an unknown session is fetched once on mount, as before', async () => {
    await render({ cookies: parseCookies({}), hasAuthCookie: true, flags: FLAGS, region: TEXAS });
    expect(requests.filter((r) => r === '/api/auth/session')).toHaveLength(1);
    expect(requests.filter((r) => r.startsWith('/api/page-data'))).toEqual([]);
    expect(last().sessionStatus).toBe('unauthenticated');
  });

  it('an absent region still opens consent, as before', async () => {
    await render({ cookies: parseCookies({}), hasAuthCookie: false, session: null, flags: FLAGS });
    expect(last().consent).toEqual({ required: false, allowed: true, consent: null });
    expect(last().regionPending).toBeUndefined();
  });

  it('a consent-required region gates from the first commit, as before', async () => {
    await render({
      cookies: parseCookies({ 'civitai-consent': 'rejected' }),
      hasAuthCookie: false,
      session: null,
      flags: FLAGS,
      region: CALIFORNIA,
    });
    expect(commits[0].consent).toEqual({ required: true, allowed: false, consent: 'rejected' });
  });
});
