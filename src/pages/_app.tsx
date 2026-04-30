// src/pages/_app.tsx

import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getCookie, getCookies, deleteCookie } from 'cookies-next';
import type { Session } from 'next-auth';
import { SessionProvider } from 'next-auth/react';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import type { ReactElement } from 'react';
import React from 'react';
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
import { GoogleAnalytics } from '~/providers/GoogleAnalytics';
import { IsClientProvider } from '~/providers/IsClientProvider';
// import { PaddleProvider } from '~/providers/PaddleProvider';
// import { PaypalProvider } from '~/providers/PaypalProvider';
// import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
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
import { VERIFIED_BOT_HEADER } from '~/server/middleware/bot-detection.middleware';
import type { VerifiedBot } from '~/server/utils/bot-detection/verify-bot';

applyNodeOverrides();

type CustomAppProps = {
  Component: CustomNextPage;
} & AppProps<{
  session: Session | null;
  colorScheme: 'light' | 'dark' | 'auto';
  cookies: ParsedCookies;
  flags: FeatureAccess;
  seed: number;
  settings: UserContentSettings;
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
      seed = Date.now(),
      canIndex,
      hasAuthCookie,
      settings,
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
      region={region}
      domain={domain}
      host={host}
      serverDomains={serverDomains}
      availableOAuthProviders={availableOAuthProviders}
      verifiedBot={verifiedBot}
    >
      <Head>
        <title>Civitai | Share your models</title>
      </Head>
      <ThemeProvider colorScheme={colorScheme}>
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
              <FeatureFlagsProvider flags={flags}>
                <GoogleAnalytics />
                <AccountProvider>
                  <CivitaiSessionProvider disableHidden={cookies.disableHidden}>
                    <ErrorBoundary>
                      <BrowserSettingsProvider>
                        <BrowsingLevelProvider>
                          <BrowsingSettingsAddonsProvider>
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
      </ThemeProvider>

      {isDev && <ReactQueryDevtools position="bottom-right" />}
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

  // Read the verified-bot header set by botDetectionMiddleware. Header
  // names are lowercased on IncomingMessage; values are string | string[].
  const rawVerifiedBot = request.headers[VERIFIED_BOT_HEADER];
  const verifiedBotValue = Array.isArray(rawVerifiedBot) ? rawVerifiedBot[0] : rawVerifiedBot;
  const verifiedBot: VerifiedBot | null =
    verifiedBotValue === 'googlebot' || verifiedBotValue === 'bingbot' ? verifiedBotValue : null;

  const { settings, session } = await fetch(`${baseUrl as string}/api/user/settings`, {
    headers: { ...request.headers } as HeadersInit,
  }).then(async (res) => {
    const data: { settings: UserContentSettings; session: Session | null } = await res.json();
    return data;
  });
  // Pass this via the request so we can use it in SSR
  const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
  const flags = await getFeatureFlagsAsync({
    user: session?.user,
    host: request?.headers.host,
    req: request,
  });

  if (session) {
    (appContext.ctx.req as any)['session'] = session;
  } else if (hasAuthCookie) {
    deleteCookie(civitaiTokenCookieName, appContext.ctx);
    hasAuthCookie = false;
  }
  const domain = getRequestDomainColor(request);

  return {
    pageProps: {
      ...pageProps,
      colorScheme,
      cookies: parsedCookies,
      canIndex,
      // cookieKeys: Object.keys(cookies),
      session,
      settings,
      flags,
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
