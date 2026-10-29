// src/pages/_app.tsx

// Side-effect import: starts the bounded console/network snapshot a bug report attaches. FIRST,
// and deliberately so — `console.error` leaves no buffer to replay, so anything React logs before
// this module evaluates (a hydration mismatch above all, which is the case the feature exists for)
// is unrecoverable. It is a no-op under SSR. See the file for the rest.
import '~/utils/feedback/startBrowserErrorLog';
import dynamic from 'next/dynamic';
// Side-effect import: globally disables next/link route prefetching. Must run
// before any <Link> mounts — see the file for rationale.
import '~/utils/disable-router-prefetch';
import { getCookie, getCookies } from 'cookies-next';
import type { Session } from '~/types/session';
import { SessionProvider } from '~/providers/SessionProvider';
import { resolveAuthGuard } from '~/server/auth/route-guard';
import { SESSION_UNRESOLVED_REQ_KEY } from '~/shared/constants/render-session.constants';
import {
  SHELL_EDGE_HEADERS,
  SHELL_RENDERED_REQ_KEY,
  SHELL_REQ_KEY,
} from '~/shared/constants/shell.constants';
import type { ShellRender } from '~/server/shell/shell-render';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import { serializeJsonLd } from '@civitai/shared/json-ld';
import type { ReactElement } from 'react';
import { useState } from 'react';
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
import { isDev, isPreview, isProd } from '~/env/other';
import { ActivityReportingProvider } from '~/providers/ActivityReportingProvider';
import { AppProvider } from '~/providers/AppProvider';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
// import { ImageProcessingProvider } from '~/components/ImageProcessing';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { FiltersProvider } from '~/providers/FiltersProvider';
import { ThirdPartyConsentProvider } from '~/components/Consent/ThirdPartyConsentProvider';
import { GoogleAnalytics } from '~/providers/GoogleAnalytics';
import { FaroProvider } from '~/components/Faro/FaroProvider';
import { isHardLoadSignedIn } from '~/utils/faro/pageAttributes';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { AppsRailProvider } from '~/components/Apps/appsRailState';
// import { PaddleProvider } from '~/providers/PaddleProvider';
// import { PaypalProvider } from '~/providers/PaypalProvider';
// import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { UserSettingsChat } from '~/server/schema/chat.schema';
import { resolveChatSettings } from '~/server/schema/chat.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { TosMeta } from '~/server/services/content.service';
import type { AnnouncementsSeed } from '~/providers/announcements-seed';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import type { SiteAlertsPayload } from '~/shared/constants/site-alert.constants';
import {
  NAV_BANNERS_DISMISSED_COOKIE,
  parseNavBannersDismissed,
} from '~/shared/constants/nav-banner.constants';
import type { DismissedByType } from '~/components/Announcements/announcements-dismissed-cookie';
import {
  ANNOUNCEMENTS_DISMISSED_COOKIE,
  parseDismissedCookieValue,
} from '~/components/Announcements/announcements-dismissed-cookie';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import type { ParsedCookies } from '~/shared/utils/cookies';
import { parseCookies } from '~/shared/utils/cookies';
import {
  hasSessionCookie,
  sessionCookieKind,
  type SessionCookieKind,
} from '~/shared/utils/session-cookie';
import { RegisterCatchNavigation } from '~/store/catch-navigation.store';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
import { trpc } from '~/utils/trpc';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { CustomModalsProvider } from '~/providers/CustomModalsProvider';
import {
  ShellBootstrapProvider,
  useShellBootstrap,
} from '~/components/Shell/ShellBootstrapProvider';

import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
import '@mantine/dates/styles.layer.css';
import '@mantine/dropzone/styles.layer.css';
import '@mantine/notifications/styles.layer.css';
import '@mantine/nprogress/styles.layer.css';
import '@mantine/tiptap/styles.layer.css';
import 'mantine-react-table/styles.css'; //import MRT styles
// `data-civitai-ui` component rules, all inside `@layer civitai.components` (ordered in
// `_document.tsx`). Tokens deliberately NOT loaded — see `ShellDs.module.css`.
import '@civitai/components/styles.css';
import { applyNodeOverrides } from '~/utils/node-override';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { getRegion } from '~/server/utils/region-blocking';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
import { getSiteSchema } from '~/components/Meta/site-schema';
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
  announcementsDismissed?: DismissedByType;
  navBanners?: NavBanner[];
  navBannersDismissed?: string[];
  siteAlerts?: SiteAlertsPayload;
  following?: number[];
  seed: number;
  settings: UserContentSettings;
  browsingSettingsAddons?: BrowsingSettingsAddon[];
  liveNow: boolean;
  // SSR-seeded `chat.getUserSettings` (logged-in only) — the per-user chat
  // settings (mute sounds / bad-word filter / acknowledged). Derived from the
  // `settings.chat` field already fetched for the bootstrap; no extra I/O. See
  // AppProvider seed.
  chatSettings?: UserSettingsChat;
  canIndex: boolean;
  hasAuthCookie: boolean;
  /** Full render only, diagnostics only: which session cookie families the request carried (names,
   *  never values), whatever the session lookup made of them (`hasAuthCookie` is narrower). Read by
   *  SessionProvider at mount. */
  sessionCookie?: SessionCookieKind;
  region?: RegionInfo;
  domain: ColorDomain;
  host: string;
  serverDomains: ServerDomains;
  availableOAuthProviders: string[];
  verifiedBot: VerifiedBot | null;
  adsGated?: boolean;
  /** Set by a static-shell render: the viewer's data comes from page data after hydration. */
  shell?: boolean;
}>;

function MyApp(props: CustomAppProps) {
  const {
    Component,
    pageProps: {
      session,
      colorScheme,
      cookies: pageCookies,
      flags,
      userFeatureFlags,
      tosMeta,
      announcements,
      announcementsDismissed,
      navBanners,
      navBannersDismissed,
      siteAlerts,
      following,
      seed = Date.now(),
      canIndex,
      hasAuthCookie: pageHasAuthCookie,
      sessionCookie: pageSessionCookie,
      settings,
      browsingSettingsAddons,
      liveNow = false,
      chatSettings,
      region,
      domain,
      host,
      serverDomains,
      availableOAuthProviders,
      verifiedBot = null,
      adsGated: pageAdsGated = false,
      shell,
      ...pageProps
    },
  } = props;

  const [siteSchema] = useState(() => getSiteSchema({ domain, serverDomains }));
  // Fixed for the tab: the shell machinery stays mounted after navigating off the shell page, so
  // the tree above the page never remounts.
  const [bootedShell] = useState(() => shell === true);
  // The hard load's viewer, for the RUM page attributes (src/utils/faro/pageAttributes.ts).
  const [bootedSignedIn] = useState(() =>
    isHardLoadSignedIn({ session, hasAuthCookie: pageHasAuthCookie })
  );
  const {
    cookies,
    hasAuthCookie,
    adsGated,
    sessionSeed,
    flagsSeed,
    appShell,
    referralsPending,
    status: shellStatus,
  } = useShellBootstrap(bootedShell, {
    onShellPage: shell === true,
    cookies: pageCookies,
    hasAuthCookie: pageHasAuthCookie,
    adsGated: pageAdsGated,
  });

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
                pageNav={Component.pageNav}
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

  const app = (
    <AppProvider
      seed={seed}
      canIndex={canIndex}
      settings={settings}
      tosMeta={tosMeta}
      announcements={announcements}
      announcementsDismissed={announcementsDismissed}
      navBanners={navBanners}
      navBannersDismissed={navBannersDismissed}
      siteAlerts={siteAlerts}
      following={following}
      liveNow={liveNow}
      chatSettings={chatSettings}
      region={region}
      domain={domain}
      host={host}
      serverDomains={serverDomains}
      availableOAuthProviders={availableOAuthProviders}
      verifiedBot={verifiedBot}
      isAuthed={!!session || hasAuthCookie}
      shell={appShell}
    >
      <Head>
        <title>Civitai | Share your models</title>
        {siteSchema && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: serializeJsonLd(siteSchema) }}
            key="site-schema"
          />
        )}
      </Head>
      <ThemeProvider colorScheme={colorScheme}>
        {/* 🔴 DO NOT pass `region` here. It is an SSR-ONLY prop (see the FaroProvider note
            below) and this provider re-evaluates on every render, so threading it made the
            consent gate DISAPPEAR on the first client-side navigation — fail-open, silently
            re-enabling third-party analytics/ads for a CA visitor who had rejected them.
            It reads the frozen `useAppContext().region` instead; see the file's own header. */}
        <ThirdPartyConsentProvider
          initialConsent={cookies.consent}
          loggedIn={!!session || hasAuthCookie}
        >
          {/* <ErrorBoundary> */}
          <SessionProvider
            session={session ? session : !hasAuthCookie ? null : undefined}
            seed={sessionSeed}
            sessionCookie={pageSessionCookie}
            refetchOnWindowFocus={false}
            refetchWhenOffline={false}
          >
            <UpdateRequiredWatcher>
              <IsClientProvider>
                {/* The `/apps/*` left rail's collapse state, SSR-seeded from the cookie
                    `parseCookies` already reads above — the same shape as
                    `cookies.consent` / `cookies.disableHidden` / `cookies.referrals`
                    going to their own providers.

                    🔴 IT IS MOUNTED HERE, ABOVE THE ROUTER OUTLET, BECAUSE THAT IS WHAT
                    MAKES THE COLLAPSE ONE GLOBAL VALUE. `AppsPageLayout` is unmounted
                    and remounted on every navigation, so state held there would re-open
                    the rail on every click between apps pages — and
                    `AppsPageLayout.chromeAlignment.browser.test.tsx` asserts the rail's
                    left edge and width are identical on all 12 routes. */}
                <AppsRailProvider value={cookies.appsRail}>
                  <ClientHistoryStore />
                  <RegisterCatchNavigation />
                  <RouterTransition />
                  {/* <ChadGPT isAuthed={!!session} /> */}
                  <FeatureFlagsProvider flags={flags} userFlags={userFeatureFlags} seed={flagsSeed}>
                    {/* Faro RUM bootstrap — dark until the `faro` flag + build-args are on.
                        `region` is the SAME SSR-derived country code AppProvider is seeded with
                        above (getRegion → cf-ipcountry/cf-region-code/x-isuk), threaded in as a
                        prop so RUM beacons carry a geography dimension (→ Loki
                        session_attr_region / session_attr_timezone). See
                        src/utils/faro/geoAttributes.ts.
                        🔴 THE CONSENT GATE MAY NOT READ IT THIS WAY AND FaroProvider MAY — the
                        difference is re-evaluation, not correctness of the value. ONCE
                        INITIALISED, FaroProvider never re-reads `region`: its `faroInitStarted`
                        module guard makes `initFaro` a no-op and its effect depends only on
                        `enabled` (see FaroProvider.tsx). The residual case is `enabled` flipping
                        false→true mid-session, which that file documents as rare and which is
                        its own pre-existing concern, not this one. ThirdPartyConsentProvider
                        re-evaluates on EVERY render, so it reads the frozen
                        `useAppContext().region` instead.
                        🔴 OPTIONAL-CHAIN IT. `region` is an SSR-ONLY prop: `getInitialProps`
                        early-returns before `getRegion(request)` on a CLIENT-SIDE navigation
                        (no `req`), so `region` is `undefined` on every route transition even
                        though `CustomAppProps` types it non-optional. A bare `region.countryCode`
                        throws inside the ROOT error boundary and white-screens the app — that is
                        exactly what shipped in v5.1.117 (#5001), surfacing in v5.1.118.
                        `FaroProvider` accepts `undefined | null`
                        by design; pinned by
                        src/tests/pages/app-region-optional-chain.test.ts. */}
                    {/* RUM page attributes: see src/utils/faro/pageAttributes.ts. */}
                    {/* `viewerFlagsReady`: a shell boot's flags are user-less until its page
                        data is adopted, and the resource_timing cohort is per user. */}
                    <FaroProvider
                      region={region?.countryCode}
                      shell={bootedShell}
                      signedIn={bootedSignedIn}
                      viewerFlagsReady={!shellStatus || shellStatus === 'ready'}
                    />
                    <GoogleAnalytics />
                    <AccountProvider>
                      <CivitaiSessionProvider disableHidden={cookies.disableHidden}>
                        <ErrorBoundary>
                          <BrowserSettingsProvider>
                            <BrowsingLevelProvider>
                              <BrowsingSettingsAddonsProvider initialData={browsingSettingsAddons}>
                                <SignalsProviderStack>
                                  <ActivityReportingProvider>
                                    <ReferralsProvider
                                      {...cookies.referrals}
                                      pending={referralsPending}
                                    >
                                      <FiltersProvider>
                                        <AdsProvider gated={adsGated}>
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
                </AppsRailProvider>
              </IsClientProvider>
            </UpdateRequiredWatcher>
          </SessionProvider>
          {/* </ErrorBoundary> */}
        </ThirdPartyConsentProvider>
      </ThemeProvider>

      {isDev && <ReactQueryDevtools buttonPosition="bottom-right" />}
    </AppProvider>
  );

  return shellStatus ? (
    <ShellBootstrapProvider status={shellStatus}>{app}</ShellBootstrapProvider>
  ) : (
    app
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
  // Server-read announcement `dismissed` state from the `announcements-dismissed`
  // cookie. `getCookies` hands us the URL-decoded JSON string, which
  // `parseDismissedCookieValue` (the SAME parser the client store uses) turns into
  // the per-type dismissed record. Threaded down so SSR + first client paint agree.
  const announcementsDismissed = parseDismissedCookieValue(
    typeof cookies[ANNOUNCEMENTS_DISMISSED_COOKIE] === 'string'
      ? (cookies[ANNOUNCEMENTS_DISMISSED_COOKIE] as string)
      : undefined
  );
  // Same for the nav announcement slot's dismissed strips.
  const navBannersDismissed = parseNavBannersDismissed(
    typeof cookies[NAV_BANNERS_DISMISSED_COOKIE] === 'string'
      ? (cookies[NAV_BANNERS_DISMISSED_COOKIE] as string)
      : undefined
  );

  // Either session cookie family, hub `civ-token` or legacy `civitai-token` (`~/shared/utils/session-cookie`).
  // Used to seed `SessionProvider` (unknown → fetch on mount) and `loggedIn` below.
  let hasAuthCookie = hasSessionCookie(cookies);
  // Kept as read: `hasAuthCookie` is cleared below when the lookup says signed out.
  const sessionCookie = sessionCookieKind(cookies);
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
  // Provider list comes from the hub (single source of provider config/secrets), cached + fail-open.
  const availableOAuthProviders = await getAvailableOAuthProviders();

  const region = getRegion(request);

  // Read the verified-bot header set by botDetectionMiddleware.
  const verifiedBot = parseVerifiedBotHeader(request.headers[VERIFIED_BOT_HEADER]);

  // Static shell (`~/server/shell/shell-mode`): ONE HTML for every viewer and every URL of the
  // route. This branch may read no session, no region, no URL and no viewer cookie but the colour
  // scheme, which is part of the edge cache key. `typeof window` block: see the bootstrap below.
  let shellRender: ShellRender | null = null;
  if (typeof window === 'undefined') {
    const { resolveShellRender } = await import('~/server/shell/shell-render');
    shellRender = await resolveShellRender(request, appContext.ctx.pathname);
  }
  const renderRequest = request as typeof request & {
    [SHELL_REQ_KEY]?: string;
    [SHELL_RENDERED_REQ_KEY]?: string;
    [SESSION_UNRESOLVED_REQ_KEY]?: boolean;
  };
  // Assigned on every run: a page that throws runs this again for `/_error`, on the same response,
  // which must then carry no edge-cache header a shell attempt may have left.
  renderRequest[SHELL_REQ_KEY] = shellRender?.route;
  renderRequest[SHELL_RENDERED_REQ_KEY] = undefined;
  if (!shellRender) {
    const { res } = appContext.ctx;
    for (const name of SHELL_EDGE_HEADERS) {
      if (res?.getHeader?.(name) !== undefined) res?.removeHeader(name);
    }
  }
  if (shellRender) {
    // 🔴 The shell must not carry its URL. Next 16.3.1 writes this very query object into
    // `__NEXT_DATA__.query` and renders with this router (`render.js`), so both are emptied here,
    // before anything renders; the client restores them from `location` (`useShellPagePending`).
    const query = appContext.ctx.query;
    for (const key of Object.keys(query)) delete query[key];
    appContext.ctx.asPath = appContext.ctx.pathname;
    (appContext.router as { asPath: string }).asPath = appContext.ctx.pathname;
    renderRequest[SESSION_UNRESOLVED_REQ_KEY] = false;

    const { seeds } = shellRender;
    // Every key here is reviewed: `shell-render.test.ts` pins the exact set.
    return {
      pageProps: {
        ...pageProps,
        shell: true,
        colorScheme: (['light', 'dark', 'auto'] as const).includes(colorScheme as 'dark')
          ? colorScheme
          : 'dark',
        cookies: parseCookies({}),
        canIndex,
        flags: shellRender.flags,
        tosMeta: seeds.tosMeta,
        browsingSettingsAddons: seeds.browsingSettingsAddons,
        liveNow: seeds.liveNow,
        // The full render's `Date.now()` would make every response distinct.
        seed: Math.floor(Date.now() / 60_000) * 60_000,
        // Unknown until the page data: SessionProvider waits for it instead of fetching.
        hasAuthCookie: true,
        domain: getRequestDomainColor(request),
        serverDomains,
        availableOAuthProviders,
        host: request.headers.host ?? '',
        verifiedBot: null,
      },
      ...appProps,
    };
  }

  // The per-user settings bootstrap, read in-process (the same function
  // `/api/user/settings` serves). This sits on EVERY SSR page render's critical
  // path, so any failure here (a failed session lookup, the render deadline, or
  // a payload with no `session` key) must NOT throw out of `getInitialProps`:
  // that would surface a user-facing 500 with no app error log. Degrade to the
  // anonymous/no-settings shape instead; the downstream consumers already
  // tolerate it (`settings` undefined → the client `user.getSettings` query
  // self-heals; `session` null → anon render; the optional seeds are
  // `enabled: !!x` gated).
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
    // Absent on the degraded path. `browsingSettingsAddons` must stay possibly-
    // undefined all the way to the provider — see the endpoint for why `[]` is
    // not a safe substitute.
    browsingSettingsAddons?: BrowsingSettingsAddon[];
    liveNow?: boolean;
    navBanners?: NavBanner[];
    siteAlerts?: SiteAlertsPayload;
    session: Session | null;
  };
  let settingsBootstrap: SettingsBootstrap;
  // True only on the DEGRADED fallback path (we couldn't obtain the bootstrap). A
  // SUCCESSFUL bootstrap carrying `session: null` looks identical in the destructured
  // shape below, but the two drive `hasAuthCookie` differently — see the carve-out
  // near the return.
  let settingsDegraded = false;
  try {
    // 🔴 The `typeof window` BLOCK is what keeps the bootstrap's server graph (database,
    // redis, server env, `fs`) out of the client bundle: both bundlers fold the condition
    // and drop the branch, import included. Keep this exact form. `if (!request) return`
    // above does NOT do it (runtime-only), and neither does an early
    // `if (typeof window !== 'undefined') return` — the webpack build keeps what follows.
    // Pinned by `no-server-infra-in-app-graph.test.ts`.
    let data: unknown;
    if (typeof window === 'undefined') {
      const { resolveSettingsBootstrapForRender } = await import(
        '~/server/services/settings-bootstrap.service'
      );
      data = await resolveSettingsBootstrapForRender(request);
    }
    // A bootstrap with NO `session` key is not authoritative, so treating it as a real
    // result would render a logged-in user as signed out. Key ABSENT ⇒ degraded; key
    // PRESENT (`session: null`) ⇒ render anonymous. `'session' in data` is the
    // discriminator — a truthiness check erases it.
    if (!data || typeof data !== 'object' || !('session' in data)) {
      throw new Error('settings bootstrap returned no session payload');
    }
    settingsBootstrap = data as SettingsBootstrap;
  } catch (e) {
    settingsDegraded = true;
    // Observable but non-fatal: log concisely and fall through to a safe render.
    // The structured marker `[_app] settings bootstrap fetch failed` is the
    // stable greppable string and the ONLY alertable signal — a genuinely-broken
    // bootstrap mass-degrades every SSR render with NO 5xx spike (we swallow the
    // throw), so it would otherwise be silent. Log-based alerting and runbooks
    // match this exact text, so it keeps the word "fetch" although the read is
    // now in-process.
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
      browsingSettingsAddons: undefined,
      liveNow: undefined,
      navBanners: undefined,
      siteAlerts: undefined,
      session: null,
    };
  }
  const {
    settings,
    session,
    tosMeta,
    announcements,
    following,
    browsingSettingsAddons,
    // Fail closed to "not live". `getLiveNow` reads the main redis with no internal
    // catch and no deadline race, so the endpoint's own `.catch` is what turns a
    // degraded read into `false`; this default covers the bootstrap fetch failing
    // outright. The client query self-heals on its 5-minute refetch.
    liveNow = false,
    navBanners,
    siteAlerts,
  } = settingsBootstrap;
  const { getFeatureFlagsAsync, computeUserFeatureFlagsOverlay, getFliptGatedEligibility } =
    await import('~/server/services/feature-flags.service');
  const flags = await getFeatureFlagsAsync({
    user: session?.user,
    host: request?.headers.host,
    req: request,
  });

  const domain = getRequestDomainColor(request);

  // SSR-inject two ambient per-bootstrap trpc results that fire on every
  // logged-in page load but are fully derivable from data already fetched here.
  // Both client queries gate on a logged-in user, so only seed for sessions.
  // - userFeatureFlags: the per-user toggleable-feature overlay
  //   (`user.getFeatureFlags`), a pure function of `settings.features` + the SSR
  //   host `flags`. Computed here via the SAME shared function the resolver uses
  //   (fs-free, safe in this client-bundled getInitialProps graph).
  // - tosMeta: the static per-domain ToS metadata (lastmod + body hash + the
  //   per-domain settings field keys) — resolved by the settings bootstrap above,
  //   behind its server-only `typeof window` block, so `content.service` (and its
  //   `fs/promises` read) never enters this client-bundled graph.
  //   ToS content only changes on a deploy (never mid-session). The show/hide
  //   decision is computed client-side in `useToSUpdateModal` against the seeded
  //   `user.getSettings`, so there is no tRPC query to seed here — `tosMeta` just
  //   rides down through pageProps to AppProvider as-is.
  let userFeatureFlags: FeatureAccess | undefined;
  if (session?.user && settings) {
    userFeatureFlags = computeUserFeatureFlagsOverlay(
      settings.features,
      flags,
      getFliptGatedEligibility({ user: session.user, host: request?.headers.host, req: request })
    );
  }

  // SSR-seed `chat.getUserSettings` (logged-in only) so the chat widget reads a
  // primed cache and never fires the query on bootstrap (~19 req/s off
  // api-primary). Fully DERIVED from the `settings.chat` field already fetched
  // above for the bootstrap — NO extra I/O. The chat settings are static per
  // user (only the user's own `setUserSettings` changes them, which patches the
  // cache via optimistic `setData`), so SSR-seeding is exact.
  //
  // Byte-equality (#2471): the `chat.getUserSettings` resolver returns
  // `settings.chat` and substitutes the SAME default object when absent — mirror
  // it here so the seed matches the resolver output exactly. Seed only when a
  // settings snapshot is present (the degraded/anon path leaves it undefined and
  // the client query self-heals).
  let chatSettings: UserSettingsChat | undefined;
  if (session?.user && settings) {
    chatSettings = resolveChatSettings(settings.chat);
  }

  // Read by the page-render metric: a render with a session cookie whose settings bootstrap failed
  // is not known to be anonymous. Assigned on every run, since a notFound runs this twice on one request.
  (appContext.ctx.req as any)[SESSION_UNRESOLVED_REQ_KEY] =
    !session && hasAuthCookie && settingsDegraded;
  if (session) {
    (appContext.ctx.req as any)['session'] = session;
  } else if (hasAuthCookie && !settingsDegraded) {
    // Render anonymous, but DO NOT delete the cookie. `session: null` is ambiguous:
    // `getServerAuthSession` fail-softs to null (`.catch(() => null)` at
    // get-server-auth-session.ts:92,102), so a hub outage is indistinguishable on the
    // wire from an expired token — and deleting on the outage durably logs out a valid
    // user. Scope: the delete this replaces named the LEGACY `civitai-token` family only,
    // so only legacy holders were ever affected either way. Cost of keeping it is near
    // zero: a civ-token's Max-Age comes from its own `exp` (civ-cookie.ts:163), so an
    // expired one is never in the jar to linger; a stale legacy cookie costs one failed
    // jose decode per request. Deleting safely needs the endpoint to signal a degraded
    // lookup distinctly from "no session".
    hasAuthCookie = false;
  }

  // Auth route guards, moved off the edge middleware (the thin hub civ-token can't resolve the full user in the
  // edge runtime — see preview-access.ts / route-guards). Runs here in Node with the resolved session, catching
  // direct/SSR loads. A non-mod can't client-nav to these (the nav isn't shown to them) and the tRPC procedures
  // are the real data gate, so the client-nav gap is harmless.
  const guardPath = (request.url ?? '').split('?')[0];
  const guard = resolveAuthGuard(guardPath, session, { isProd, isPreview });
  let guardTo: string | undefined;
  if (guard && 'redirect' in guard) {
    guardTo = guard.redirect;
  } else if (guard && 'needsPreviewCheck' in guard && session?.user) {
    // Logged-in non-moderator on a preview deploy → resolve the allowlist via Flipt (async, kept out of the guard).
    const { checkPreviewAccess } = await import('~/server/auth/preview-access');
    if (!(await checkPreviewAccess(session.user))) guardTo = '/preview-restricted';
  }
  if (!guardTo && typeof window === 'undefined') {
    const { sharedSlotNavigationSyncUrl } = await import('~/server/auth/shared-slot-sync');
    guardTo =
      sharedSlotNavigationSyncUrl({
        method: request.method,
        url: request.url,
        headers: request.headers,
        cookies,
      }) ?? undefined;
  }
  // 🔴 Next still runs the page's `getServerSideProps` after this, and re-enters this function on
  // the SAME, already-sent response when it returns `notFound` (re-render of /404) or throws
  // (re-render of /_error). A second `writeHead` there throws ERR_HTTP_HEADERS_SENT.
  // Pinned by `app-guard-redirect-once.test.ts`.
  if (guardTo && appContext.ctx.res && !appContext.ctx.res.headersSent) {
    appContext.ctx.res.writeHead(302, { Location: guardTo });
    appContext.ctx.res.end();
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
      // Every seed computed above must be returned here; `app-ssr-seeds.test.ts` pins the ones it lists.
      chatSettings,
      flags,
      userFeatureFlags,
      tosMeta,
      announcements,
      announcementsDismissed,
      navBanners,
      navBannersDismissed,
      siteAlerts,
      following,
      seed: Date.now(),
      hasAuthCookie,
      sessionCookie,
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
