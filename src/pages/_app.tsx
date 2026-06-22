// src/pages/_app.tsx

import dynamic from 'next/dynamic';
// Side-effect import: globally disables next/link route prefetching. Must run
// before any <Link> mounts — see the file for rationale.
import '~/utils/disable-router-prefetch';
import { getCookie, getCookies, deleteCookie } from 'cookies-next';
import type { Session } from 'next-auth';
import { SessionProvider } from 'next-auth/react';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import type { ReactElement } from 'react';
import { AdsProvider } from '~/components/Ads/AdsProvider';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { BaseLayout } from '~/components/AppLayout/BaseLayout';
import { FeatureLayout } from '~/components/AppLayout/FeatureLayout';
import type { CustomNextPage } from '~/components/AppLayout/Page';
import { AuctionContextProvider } from '~/components/Auction/AuctionProvider';
import { BrowserRouterProvider } from '~/components/BrowserRouter/BrowserRouterProvider';
import {
  BrowsingLevelProvider,
  BrowsingLevelProviderOptional,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
// import ChadGPT from '~/components/ChadGPT/ChadGPT';
import { CivitaiLinkProvider } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { AccountProvider } from '~/components/CivitaiWrapped/AccountProvider';
import { CivitaiSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { RoutedDialogProvider } from '~/components/Dialog/RoutedDialogProvider';
import { ErrorBoundary } from '~/components/ErrorBoundary/ErrorBoundary';
import { HiddenPreferencesProvider } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
// import { RecaptchaWidgetProvider } from '~/components/Recaptcha/RecaptchaWidget';
import { ReferralsProvider } from '~/components/Referrals/ReferralsProvider';
import { RouterTransition } from '~/components/RouterTransition/RouterTransition';
import { SignalsProviderStack } from '~/components/Signals/SignalsProviderStack';
import { ToursProvider } from '~/components/Tours/ToursProvider';
import { TrackPageView } from '~/components/TrackView/TrackPageView';
import { UpdateRequiredWatcher } from '~/components/UpdateRequiredWatcher/UpdateRequiredWatcher';
import { env } from '~/env/client';
import { isDev, isProd } from '~/env/other';
import { civitaiTokenCookieName } from '~/libs/auth';
import { ActivityReportingProvider } from '~/providers/ActivityReportingProvider';
import { AppProvider } from '~/providers/AppProvider';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
// import { ImageProcessingProvider } from '~/components/ImageProcessing';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { FiltersProvider } from '~/providers/FiltersProvider';
import { ThirdPartyConsentProvider } from '~/components/Consent/ThirdPartyConsentProvider';
import { GoogleAnalytics } from '~/providers/GoogleAnalytics';
import { IsClientProvider } from '~/providers/IsClientProvider';
// import { PaddleProvider } from '~/providers/PaddleProvider';
// import { PaypalProvider } from '~/providers/PaypalProvider';
// import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { GetSignalsAccessTokenResponse } from '~/server/schema/signals.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { TosMeta } from '~/server/services/content.service';
import type { AnnouncementsSeed } from '~/providers/announcements-seed';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import type { ParsedCookies } from '~/shared/utils/cookies';
import { parseCookies } from '~/shared/utils/cookies';
import { RegisterCatchNavigation } from '~/store/catch-navigation.store';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
import { trpc } from '~/utils/trpc';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { CustomModalsProvider } from '~/providers/CustomModalsProvider';

import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
import '@mantine/dates/styles.layer.css';
import '@mantine/dropzone/styles.layer.css';
import '@mantine/notifications/styles.layer.css';
import '@mantine/nprogress/styles.layer.css';
import '@mantine/tiptap/styles.layer.css';
import 'mantine-react-table/styles.css'; //import MRT styles
import { applyNodeOverrides } from '~/utils/node-override';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { getRegion } from '~/server/utils/region-blocking';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import type { VerifiedBot } from '~/server/utils/bot-detection/verify-bot';

applyNodeOverrides();

// React Query Devtools renders a container div and mounts its UI imperatively
// in an effect, so it is not SSR-safe: the server emits its div but the client
// doesn't reproduce it during hydration, which under Turbopack trips a
// dev-only hydration mismatch. Load it client-only so it never participates in
// SSR/hydration. Dev-only anyway.
const ReactQueryDevtools = dynamic(
  () => import('@tanstack/react-query-devtools').then((m) => m.ReactQueryDevtools),
  { ssr: false }
);

type CustomAppProps = {
  Component: CustomNextPage;
} & AppProps<{
  session: Session | null;
  colorScheme: 'light' | 'dark' | 'auto';
  cookies: ParsedCookies;
  flags: FeatureAccess;
  userFeatureFlags?: FeatureAccess;
  tosMeta?: TosMeta;
  announcements?: AnnouncementsSeed;
  following?: number[];
  seed: number;
  settings: UserContentSettings;
  browsingSettingsAddons: BrowsingSettingsAddon[];
  liveNow: boolean;
  // SSR-seeded `signals.getToken` (logged-in only) — the SignalR access token
  // the signals SharedWorker uses to open the live connection. Optional: absent
  // for anon and on the fail-soft path (the worker reads `data?.accessToken` as
  // undefined and simply doesn't connect, exactly as today). See AppProvider seed.
  signalsToken?: GetSignalsAccessTokenResponse;
  canIndex: boolean;
  hasAuthCookie: boolean;
  region: RegionInfo;
  domain: ColorDomain;
  host: string;
  serverDomains: ServerDomains;
  availableOAuthProviders: string[];
  verifiedBot: VerifiedBot | null;
}>;

function MyApp(props: CustomAppProps) {
  const {
    Component,
    pageProps: {
      session,
      colorScheme,
      cookies = parseCookies(getCookies()),
      flags,
      userFeatureFlags,
      tosMeta,
      announcements,
      following,
      seed = Date.now(),
      canIndex,
      hasAuthCookie,
      settings,
      browsingSettingsAddons,
      liveNow = false,
      signalsToken,
      region,
      domain,
      host,
      serverDomains,
      availableOAuthProviders,
      verifiedBot = null,
      ...pageProps
    },
  } = props;

  // // Standalone pages bypass all providers and render directly
  // if ('standalone' in Component && Component.standalone) {
  //   return <Component {...pageProps} />;
  // }

  const getLayout = (page: ReactElement) =>
    'standalone' in Component && Component.standalone ? (
      <Component {...pageProps} />
    ) : (
      <FeatureLayout conditional={Component?.features}>
        <BrowsingLevelProviderOptional browsingLevel={Component.browsingLevel}>
          <BrowsingSettingsAddonsProvider>
            {Component.getLayout?.(page) ?? (
              <AppLayout
                left={Component.left}
                right={Component.right}
                subNav={Component.subNav}
                scrollable={Component.scrollable}
                header={Component.header}
                footer={Component.footer}
                announcements={Component.announcements}
              >
                {Component.InnerLayout ? (
                  <Component.InnerLayout>{page}</Component.InnerLayout>
                ) : (
                  page
                )}
              </AppLayout>
            )}
          </BrowsingSettingsAddonsProvider>
        </BrowsingLevelProviderOptional>
      </FeatureLayout>
    );

  return (
    <AppProvider
      seed={seed}
      canIndex={canIndex}
      settings={settings}
      tosMeta={tosMeta}
      announcements={announcements}
      following={following}
      liveNow={liveNow}
      signalsToken={signalsToken}
      region={region}
      domain={domain}
      host={host}
      serverDomains={serverDomains}
      availableOAuthProviders={availableOAuthProviders}
      verifiedBot={verifiedBot}
      isAuthed={!!session || hasAuthCookie}
    >
      <Head>
        <title>Civitai | Share your models</title>
      </Head>
      <ThemeProvider colorScheme={colorScheme}>
        <ThirdPartyConsentProvider
          region={region}
          initialConsent={cookies.consent}
          loggedIn={!!session || hasAuthCookie}
        >
          {/* <ErrorBoundary> */}
          <SessionProvider
            session={session ? session : !hasAuthCookie ? null : undefined}
            refetchOnWindowFocus={false}
            refetchWhenOffline={false}
          >
            <UpdateRequiredWatcher>
              <IsClientProvider>
                <ClientHistoryStore />
                <RegisterCatchNavigation />
                <RouterTransition />
                {/* <ChadGPT isAuthed={!!session} /> */}
                <FeatureFlagsProvider flags={flags} userFlags={userFeatureFlags}>
                  <GoogleAnalytics />
                  <AccountProvider>
                    <CivitaiSessionProvider disableHidden={cookies.disableHidden}>
                      <ErrorBoundary>
                        <BrowserSettingsProvider>
                          <BrowsingLevelProvider>
                            <BrowsingSettingsAddonsProvider initialData={browsingSettingsAddons}>
                              <SignalsProviderStack>
                                <ActivityReportingProvider>
                                  <ReferralsProvider {...cookies.referrals}>
                                    <FiltersProvider>
                                      <AdsProvider>
                                        <HiddenPreferencesProvider>
                                          <CivitaiLinkProvider>
                                            <BrowserRouterProvider>
                                              <IntersectionObserverProvider>
                                                <ToursProvider>
                                                  <AuctionContextProvider>
                                                    <BaseLayout>
                                                      {isProd && <TrackPageView />}
                                                      <CustomModalsProvider>
                                                        {getLayout(<Component {...pageProps} />)}
                                                        {/* <StripeSetupSuccessProvider /> */}
                                                        <DialogProvider />
                                                        <RoutedDialogProvider />
                                                      </CustomModalsProvider>
                                                    </BaseLayout>
                                                  </AuctionContextProvider>
                                                </ToursProvider>
                                              </IntersectionObserverProvider>
                                            </BrowserRouterProvider>
                                          </CivitaiLinkProvider>
                                        </HiddenPreferencesProvider>
                                      </AdsProvider>
                                    </FiltersProvider>
                                  </ReferralsProvider>
                                </ActivityReportingProvider>
                              </SignalsProviderStack>
                            </BrowsingSettingsAddonsProvider>
                          </BrowsingLevelProvider>
                        </BrowserSettingsProvider>
                      </ErrorBoundary>
                    </CivitaiSessionProvider>
                  </AccountProvider>
                </FeatureFlagsProvider>
              </IsClientProvider>
            </UpdateRequiredWatcher>
          </SessionProvider>
          {/* </ErrorBoundary> */}
        </ThirdPartyConsentProvider>
      </ThemeProvider>

      {isDev && <ReactQueryDevtools buttonPosition="bottom-right" />}
    </AppProvider>
  );
}

// MyApp.getInitialProps = async (appContext: AppContext) => {
//   const initialProps = await App.getInitialProps(appContext);
//   if (!appContext.ctx.req) return initialProps;

//   // const url = appContext.ctx.req?.url;
//   // console.log({ url });
//   // const isClient = !url || url?.startsWith('/_next/data');

//   const { pageProps, ...appProps } = initialProps;
//   const colorScheme = getCookie('mantine-color-scheme', appContext.ctx) ?? 'dark';
//   const cookies = getCookies(appContext.ctx);
//   const parsedCookies = parseCookies(cookies);

//   const hasAuthCookie = Object.keys(cookies).some((x) => x.endsWith('civitai-token'));
//   const session = hasAuthCookie ? await getSession(appContext.ctx) : undefined;
//   // const flags = getFeatureFlags({ user: session?.user, host: appContext.ctx.req?.headers.host });
//   const flags = getFeatureFlags({ host: appContext.ctx.req?.headers.host });

//   // Pass this via the request so we can use it in SSR
//   if (session) {
//     (appContext.ctx.req as any)['session'] = session;
//     // (appContext.ctx.req as any)['flags'] = flags;
//   }

//   return {
//     pageProps: {
//       ...pageProps,
//       colorScheme,
//       cookies: parsedCookies,
//       // cookieKeys: Object.keys(cookies),
//       session,
//       flags,
//       seed: Date.now(),
//       hasAuthCookie,
//     },
//     ...appProps,
//   };
// };
const baseUrl = process.env.NEXTAUTH_URL_INTERNAL ?? env.NEXT_PUBLIC_BASE_URL;
// Bound the server-side self-fetch to `/api/user/settings` so a slow/hung apex
// Service endpoint can't stall every SSR render's critical path. The endpoint
// does session + settings + a 3-way Promise.all (tos/announcements/follows) —
// several DB/redis round-trips — so under rollout load it can be slow-but-
// successful. 8s sits well under the gateway/kubelet ceilings but only trips on
// a genuine hang (don't abort a fetch that would have succeeded → needless
// degraded render). Env-overridable for tuning. (Confirm P99 from Tempo.)
// Clamp to a positive floor: `AbortSignal.timeout()` throws RangeError on a
// negative value, so a fat-fingered/negative env override (e.g. `-1`) would
// throw on EVERY render and silently force the permanent-degrade path. Floor at
// 1s; a too-low (but positive) value at worst over-degrades, it can't crash.
const SETTINGS_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.APP_SETTINGS_FETCH_TIMEOUT_MS) || 8000
);
MyApp.getInitialProps = async (appContext: AppContext) => {
  const initialProps = await App.getInitialProps(appContext);
  const { req: request } = appContext.ctx;
  if (!request) return initialProps;
  // Everything below this point is only serverside

  // const url = appContext.ctx?.req?.url;

  const { pageProps, ...appProps } = initialProps;
  const colorScheme = getCookie('mantine-color-scheme', appContext.ctx) ?? 'dark';
  const cookies = getCookies(appContext.ctx);
  const parsedCookies = parseCookies(cookies);

  let hasAuthCookie = Object.keys(cookies).some((x) => x.endsWith('civitai-token'));
  // const session = hasAuthCookie ? await getSession(appContext.ctx) : undefined;
  // const flags = getFeatureFlags({ user: session?.user, host: appContext.ctx.req?.headers.host });
  const { serverDomainMap, getRequestDomainColor, getAllServerHosts, getAvailableOAuthProviders } =
    await import('~/server/utils/server-domain');
  const serverDomains: ServerDomains = {
    green: serverDomainMap.green,
    blue: serverDomainMap.blue,
    red: serverDomainMap.red,
  };
  const canIndex = getAllServerHosts().includes((request.headers.host ?? '').toLowerCase());
  const availableOAuthProviders = getAvailableOAuthProviders(request.headers.host);

  const region = getRegion(request);

  // Read the verified-bot header set by botDetectionMiddleware.
  const verifiedBot = parseVerifiedBotHeader(request.headers[VERIFIED_BOT_HEADER]);

  // Self-fetch the pod's own apex Service for the per-user settings bootstrap.
  // This sits on EVERY SSR page render's critical path with no resolver behind
  // it, so any failure here (fetch reject — ECONNREFUSED/ECONNRESET from a
  // churning keep-alive socket — timeout/abort, non-OK status, or a `res.json()`
  // reject) must NOT throw out of `getInitialProps`: that would surface a
  // user-facing 500 with no app error log. Degrade to the anonymous/no-settings
  // shape instead; the downstream consumers already tolerate it (`settings`
  // undefined → the client `user.getSettings` query self-heals; `session` null →
  // anon render; the optional seeds are `enabled: !!x` gated).
  // The success-path shape is identical to before; on failure we fall back to
  // the anonymous/no-settings shape. `settings` keeps its original
  // `UserContentSettings` type (downstream consumers already treat an undefined
  // runtime value as "no snapshot" — see the `if (session?.user && settings)`
  // gate and `initialData: settings` below), so the fallback `undefined` matches
  // the documented failed-snapshot path without widening any downstream type.
  type SettingsBootstrap = {
    settings: UserContentSettings;
    tosMeta?: TosMeta;
    announcements?: AnnouncementsSeed;
    following?: number[];
    signalsToken?: GetSignalsAccessTokenResponse;
    session: Session | null;
  };
  let settingsBootstrap: SettingsBootstrap;
  // True only on the DEGRADED fallback path (we couldn't reach/parse the
  // settings endpoint). Distinct from a SUCCESSFUL fetch that returned
  // `session: null` (genuinely expired/invalid token). The two look identical in
  // the destructured shape below (both have `session: null`) but must be treated
  // differently for the auth cookie — see the cookie carve-out near the return.
  let settingsDegraded = false;
  try {
    const res = await fetch(`${baseUrl as string}/api/user/settings`, {
      headers: { ...request.headers } as HeadersInit,
      signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`settings fetch returned ${res.status}`);
    const data = (await res.json()) as SettingsBootstrap;
    // The endpoint's OWN internal catch swallows transient errors (e.g. a DB
    // blip on a draining pod mid-roll) into a SUCCESSFUL `200 {}` — a body with
    // NO `session` key. That sails past the `!res.ok` guard but carries no
    // authoritative session, so treating it as a real result would delete the
    // auth cookie (key absent ≠ `session: null`) and log the user out — the exact
    // vector this fix exists to kill. Distinguish on KEY PRESENCE: a genuinely
    // logged-out user gets `session: null` (key present → not degraded, cookie
    // cleanup is correct); an internal swallow gets `{}` (key absent → degrade,
    // preserve the cookie). `'session' in data` is the precise discriminator.
    if (!data || typeof data !== 'object' || !('session' in data)) {
      throw new Error('settings fetch returned no session payload (endpoint-swallowed error)');
    }
    settingsBootstrap = data;
  } catch (e) {
    settingsDegraded = true;
    // Observable but non-fatal: log concisely and fall through to a safe render.
    // The structured marker `[_app] settings bootstrap fetch failed` is the
    // stable greppable string and the ONLY alertable signal — a genuinely-broken
    // settings endpoint mass-degrades every SSR render with NO 5xx spike (we
    // swallow the throw), so it would otherwise be silent. A Loki log-rate alert
    // on this marker is wired on the datapacket-talos side.
    // NB: deliberately NO prom-client metric here — `_app.tsx` runs in BOTH the
    // client and server bundles, and importing `~/server/prom/client` (even
    // dynamically) pulls `prom-client` → Node built-ins (`tls`/`v8`) into the
    // CLIENT bundle and breaks `next build` ("Can't resolve 'tls'/'v8'"). The
    // greppable warn + Loki alert is the agreed signal.
    console.warn(
      `[_app] settings bootstrap fetch failed, rendering without it: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    settingsBootstrap = {
      settings: undefined as unknown as UserContentSettings,
      tosMeta: undefined,
      announcements: undefined,
      following: undefined,
      signalsToken: undefined,
      session: null,
    };
  }
  const { settings, session, tosMeta, announcements, following, signalsToken } =
    settingsBootstrap;
  // Pass these via the request so we can use them in SSR. Resolve the per-user
  // feature flags and the global (redis-cached, identical-for-all-users) browsing
  // setting addons in PARALLEL — neither depends on the other and both sit on
  // every full render's critical path. SSR-injecting the addons keeps the
  // `system.getBrowsingSettingAddons` round-trip off api-primary (it becomes
  // `initialData` for the client provider).
  const [
    { getFeatureFlagsAsync, computeUserFeatureFlagsOverlay },
    { getBrowsingSettingAddons, getLiveNow },
  ] = await Promise.all([
    import('~/server/services/feature-flags.service'),
    import('~/server/services/system-cache'),
  ]);
  const [flags, browsingSettingsAddons] = await Promise.all([
    getFeatureFlagsAsync({
      user: session?.user,
      host: request?.headers.host,
      req: request,
    }),
    getBrowsingSettingAddons(),
  ]);

  // SSR-seed the global `system.getLiveNow` boolean (a single `redis.get`,
  // identical for every user) so the ambient `useIsLive` client query reads a
  // primed cache and never fires on bootstrap (~26 req/s off api-primary).
  // Fail open to `false` (the "not live" default): `getLiveNow` has no internal
  // try/catch, and an uncaught redis throw here would 500 every page render —
  // so a degraded sysRedis must degrade to "not live", never to an error. The
  // client query still self-heals on its 5-minute refetch interval.
  let liveNow = false;
  try {
    liveNow = await getLiveNow();
  } catch (e) {
    console.warn(
      `[_app] getLiveNow bootstrap failed, defaulting to not-live: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  const domain = getRequestDomainColor(request);

  // NOTE: `signals.getToken` (the SignalR access token the signals SharedWorker
  // uses to open the live connection, ~10 req/s off api-primary) is SSR-seeded
  // too, but it is computed in the server-only `/api/user/settings` route above
  // and delivered via that fetch (read off `settingsBootstrap` as
  // `signalsToken`). It is deliberately NOT resolved here: `signals.service` is
  // server-only and importing it into this graph — even via a dynamic
  // `await import` — pulls Node built-ins (`tls`/`v8`/`node:perf_hooks`, via the
  // `env/server` + `prom-client` chain in the `withSignals` wrapper) into
  // `_app`'s client bundle and breaks `next build` (same class as the
  // `content.service`/`announcement.service` carve-outs above and the
  // `prom-client` note in the settings-fetch catch). It rides down through
  // pageProps to AppProvider and seeds the ambient query there. This CANNOT be
  // deferred to first interaction: the SignalR connection it powers must open on
  // first paint to deliver the live buzz/generation/chat/notification updates
  // the whole app depends on. `getAccessToken` is already fully fail-soft
  // (PR #2366): a signals-service blip degrades to `{}` (the worker reads
  // `data?.accessToken` as undefined and simply doesn't connect, exactly as
  // today), and the route additionally `.catch`es the only non-soft path → an
  // absent seed → the worker's own query self-heals. So a degraded signals
  // service can never 500 a page render.

  // SSR-inject two ambient per-bootstrap trpc results that fire on every
  // logged-in page load but are fully derivable from data already fetched here.
  // Both client queries gate on a logged-in user, so only seed for sessions.
  // - userFeatureFlags: the per-user toggleable-feature overlay
  //   (`user.getFeatureFlags`), a pure function of `settings.features` + the SSR
  //   host `flags`. Computed here via the SAME shared function the resolver uses
  //   (fs-free, safe in this client-bundled getInitialProps graph).
  // - tosMeta: the static per-domain ToS metadata (lastmod + body hash + the
  //   per-domain settings field keys) — resolved server-side in the
  //   `/api/user/settings` route above and delivered via that fetch, so we never
  //   import `content.service` (and its `fs/promises` read) into this graph.
  //   ToS content only changes on a deploy (never mid-session). The show/hide
  //   decision is computed client-side in `useToSUpdateModal` against the seeded
  //   `user.getSettings`, so there is no tRPC query to seed here — `tosMeta` just
  //   rides down through pageProps to AppProvider (its `lastmod` is revived there).
  let userFeatureFlags: FeatureAccess | undefined;
  if (session?.user && settings) {
    userFeatureFlags = computeUserFeatureFlagsOverlay(settings.features, flags);
  }

  if (session) {
    (appContext.ctx.req as any)['session'] = session;
  } else if (hasAuthCookie && !settingsDegraded) {
    // Only clear the auth cookie when the settings fetch SUCCEEDED and authoritatively
    // returned no session — i.e. the token is genuinely expired/invalid, so cleaning up
    // the stale cookie is correct. On the DEGRADED path we never reached the endpoint, so
    // we DON'T KNOW the session: deleting the cookie here would durably log out a
    // valid user (worse than the retryable failure this fix exists to soften). Don't
    // conflate "couldn't reach settings" with "token invalid" — preserve the cookie and
    // let the client refetch (the SessionProvider seed below already yields `undefined`
    // → client refetch when hasAuthCookie is true and session is null).
    deleteCookie(civitaiTokenCookieName, appContext.ctx);
    hasAuthCookie = false;
  }

  return {
    pageProps: {
      ...pageProps,
      colorScheme,
      cookies: parsedCookies,
      canIndex,
      // cookieKeys: Object.keys(cookies),
      session,
      settings,
      browsingSettingsAddons,
      liveNow,
      signalsToken,
      flags,
      userFeatureFlags,
      tosMeta,
      announcements,
      following,
      seed: Date.now(),
      hasAuthCookie,
      region,
      domain,
      serverDomains,
      availableOAuthProviders,
      host: appContext.ctx.req?.headers.host ?? '',
      verifiedBot,
    },
    ...appProps,
  };
};

export default trpc.withTRPC(MyApp);
