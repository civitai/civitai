// src/pages/_app.tsx

import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getCookie, getCookies } from 'cookies-next';
import type { Session, SessionUser } from 'next-auth';
import { getToken } from 'next-auth/jwt';
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
import { ChatContextProvider } from '~/components/Chat/ChatProvider';
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
import { PaddleProvider } from '~/providers/PaddleProvider';
// import { PaypalProvider } from '~/providers/PaypalProvider';
// import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlags, serverDomainMap } from '~/server/services/feature-flags.service';
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

applyNodeOverrides();

type CustomAppProps = {
  Component: CustomNextPage;
} & AppProps<{
  session: Session | null;
  colorScheme: 'light' | 'dark' | 'auto';
  cookies: ParsedCookies;
  flags: FeatureAccess;
  seed: number;
  settings: UserSettingsSchema;
  canIndex: boolean;
  hasAuthCookie: boolean;
  region: RegionInfo;
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
      ...pageProps
    },
  } = props;

  const getLayout = (page: ReactElement) => (
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
              {Component.InnerLayout ? <Component.InnerLayout>{page}</Component.InnerLayout> : page}
            </AppLayout>
          )}
        </BrowsingSettingsAddonsProvider>
      </BrowsingLevelProviderOptional>
    </FeatureLayout>
  );

  return (
    <AppProvider seed={seed} canIndex={canIndex} settings={settings} region={region}>
      <Head>
        <title>Civitai | Share your models</title>
      </Head>
      <ThemeProvider colorScheme={colorScheme}>
        {/* <ErrorBoundary> */}
        <UpdateRequiredWatcher>
          <IsClientProvider>
            <ClientHistoryStore />
            <RegisterCatchNavigation />
            <RouterTransition />
            {/* <ChadGPT isAuthed={!!session} /> */}
            <SessionProvider
              session={session ? session : !hasAuthCookie ? null : undefined}
              refetchOnWindowFocus={false}
              refetchWhenOffline={false}
            >
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
                                      <PaddleProvider>
                                        <HiddenPreferencesProvider>
                                          <CivitaiLinkProvider>
                                            <BrowserRouterProvider>
                                              <IntersectionObserverProvider>
                                                <ToursProvider>
                                                  <AuctionContextProvider>
                                                    <BaseLayout>
                                                      {isProd && <TrackPageView />}
                                                      <ChatContextProvider>
                                                        <CustomModalsProvider>
                                                          {getLayout(<Component {...pageProps} />)}
                                                          {/* <StripeSetupSuccessProvider /> */}
                                                          <DialogProvider />
                                                          <RoutedDialogProvider />
                                                        </CustomModalsProvider>
                                                      </ChatContextProvider>
                                                    </BaseLayout>
                                                  </AuctionContextProvider>
                                                </ToursProvider>
                                              </IntersectionObserverProvider>
                                            </BrowserRouterProvider>
                                          </CivitaiLinkProvider>
                                        </HiddenPreferencesProvider>
                                      </PaddleProvider>
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
            </SessionProvider>
          </IsClientProvider>
        </UpdateRequiredWatcher>
        {/* </ErrorBoundary> */}
      </ThemeProvider>

      {isDev && <ReactQueryDevtools />}
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

  const hasAuthCookie = Object.keys(cookies).some((x) => x.endsWith('civitai-token'));
  // const session = hasAuthCookie ? await getSession(appContext.ctx) : undefined;
  // const flags = getFeatureFlags({ user: session?.user, host: appContext.ctx.req?.headers.host });
  const canIndex = Object.values(serverDomainMap).includes(request.headers.host);
  const token = await getToken({
    req: appContext.ctx.req as any,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName: civitaiTokenCookieName,
  });

  const session = token?.user ? { user: token.user as SessionUser } : null;
  const flags = getFeatureFlags({ user: session?.user, host: request?.headers.host });

  const settings = await fetch(`${baseUrl as string}/api/user/settings`, {
    headers: { ...request.headers } as HeadersInit,
  }).then((res) => res.json() as UserSettingsSchema);
  // Pass this via the request so we can use it in SSR
  if (session) {
    (appContext.ctx.req as any)['session'] = session;
  }
  const region = getRegion(request);

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
    },
    ...appProps,
  };
};

export default trpc.withTRPC(MyApp);
