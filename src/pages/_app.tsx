// src/pages/_app.tsx

import dynamic from 'next/dynamic';
// Side-effect import: globally disables next/link route prefetching. Must run
// before any <Link> mounts — see the file for rationale.
import '~/utils/disable-router-prefetch';
import { getCookies } from 'cookies-next';
import type { Session } from '~/types/session';
import { SessionProvider } from '~/providers/SessionProvider';
import type { AppProps } from 'next/app';
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
import { isDev, isProd } from '~/env/other';
import { ActivityReportingProvider } from '~/providers/ActivityReportingProvider';
import { AppProvider } from '~/providers/AppProvider';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
// import { ImageProcessingProvider } from '~/components/ImageProcessing';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { FiltersProvider } from '~/providers/FiltersProvider';
import { ThirdPartyConsentProvider } from '~/components/Consent/ThirdPartyConsentProvider';
import { GoogleAnalytics } from '~/providers/GoogleAnalytics';
import { FaroProvider } from '~/components/Faro/FaroProvider';
import { IsClientProvider } from '~/providers/IsClientProvider';
// import { PaddleProvider } from '~/providers/PaddleProvider';
// import { PaypalProvider } from '~/providers/PaypalProvider';
// import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { UserSettingsChat } from '~/server/schema/chat.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { TosMeta } from '~/server/services/content.service';
import type { AnnouncementsSeed } from '~/providers/announcements-seed';
import type { DismissedByType } from '~/components/Announcements/announcements-dismissed-cookie';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import type { ParsedCookies } from '~/shared/utils/cookies';
import { parseCookies } from '~/shared/utils/cookies';
import { RegisterCatchNavigation } from '~/store/catch-navigation.store';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
import { trpc } from '~/utils/trpc';
import { getAppInitialProps } from '~/utils/app-initial-props';
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
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';
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
  region: RegionInfo;
  domain: ColorDomain;
  host: string;
  serverDomains: ServerDomains;
  availableOAuthProviders: string[];
  verifiedBot: VerifiedBot | null;
  adsGated?: boolean;
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
      announcementsDismissed,
      following,
      seed = Date.now(),
      canIndex,
      hasAuthCookie,
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
      adsGated = false,
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
      announcementsDismissed={announcementsDismissed}
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
                  {/* Faro RUM bootstrap — dark until the `faro` flag + build-args are on */}
                  <FaroProvider />
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

MyApp.getInitialProps = getAppInitialProps;

export default trpc.withTRPC(MyApp);
