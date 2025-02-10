// src/pages/_app.tsx
import { ColorScheme } from '@mantine/core';
import { NotificationsProvider } from '@mantine/notifications';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getCookie, getCookies } from 'cookies-next';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import isBetween from 'dayjs/plugin/isBetween';
import minMax from 'dayjs/plugin/minMax';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import { registerCustomProtocol } from 'linkifyjs';
import type { Session } from 'next-auth';
import { SessionProvider } from 'next-auth/react';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import React, { ReactElement } from 'react';
import { AdsProvider } from '~/components/Ads/AdsProvider';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { BaseLayout } from '~/components/AppLayout/BaseLayout';
import { FeatureLayout } from '~/components/AppLayout/FeatureLayout';
import { CustomNextPage } from '~/components/AppLayout/Page';
import { BrowserRouterProvider } from '~/components/BrowserRouter/BrowserRouterProvider';
import {
  BrowsingLevelProviderOptional,
  BrowsingLevelProvider,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
// import ChadGPT from '~/components/ChadGPT/ChadGPT';
import { ChatContextProvider } from '~/components/Chat/ChatProvider';
import { CivitaiLinkProvider } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { AccountProvider } from '~/components/CivitaiWrapped/AccountProvider';
import { CivitaiSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { RoutedDialogProvider } from '~/components/Dialog/RoutedDialogProvider';
import { HiddenPreferencesProvider } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
// import { RecaptchaWidgetProvider } from '~/components/Recaptcha/RecaptchaWidget';
import { ReferralsProvider } from '~/components/Referrals/ReferralsProvider';
import { RouterTransition } from '~/components/RouterTransition/RouterTransition';
import { SignalProvider } from '~/components/Signals/SignalsProvider';
import { TrackPageView } from '~/components/TrackView/TrackPageView';
import { UpdateRequiredWatcher } from '~/components/UpdateRequiredWatcher/UpdateRequiredWatcher';
import { isDev, isProd } from '~/env/other';
import { ActivityReportingProvider } from '~/providers/ActivityReportingProvider';
import { AppProvider } from '~/providers/AppProvider';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
import { CustomModalsProvider } from '~/providers/CustomModalsProvider';
// import { ImageProcessingProvider } from '~/components/ImageProcessing';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { FiltersProvider } from '~/providers/FiltersProvider';
import { GoogleAnalytics } from '~/providers/GoogleAnalytics';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { PaddleProvider } from '~/providers/PaddleProvider';
// import { PaypalProvider } from '~/providers/PaypalProvider';
// import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlags, serverDomainMap } from '~/server/services/feature-flags.service';
import { parseCookies, ParsedCookies } from '~/shared/utils';
import { RegisterCatchNavigation } from '~/store/catch-navigation.store';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
import { trpc } from '~/utils/trpc';
import '~/styles/globals.css';
import { ErrorBoundary } from '~/components/ErrorBoundary/ErrorBoundary';
import { getToken } from 'next-auth/jwt';
import { civitaiTokenCookieName } from '~/libs/auth';

dayjs.extend(duration);
dayjs.extend(isBetween);
dayjs.extend(minMax);
dayjs.extend(relativeTime);
dayjs.extend(utc);

registerCustomProtocol('civitai', true);
// registerCustomProtocol('urn', true);

type CustomAppProps = {
  Component: CustomNextPage;
} & AppProps<{
  session: Session | null;
  colorScheme: ColorScheme;
  cookies: ParsedCookies;
  flags?: FeatureAccess;
  seed: number;
  canIndex: boolean;
  hasAuthCookie: boolean;
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
      ...pageProps
    },
  } = props;

  const getLayout = (page: ReactElement) => (
    <FeatureLayout conditional={Component?.features}>
      <BrowsingLevelProviderOptional browsingLevel={Component.browsingLevel}>
        {Component.getLayout?.(page) ?? (
          <AppLayout
            left={Component.left}
            right={Component.right}
            subNav={Component.subNav}
            scrollable={Component.scrollable}
            footer={Component.footer}
            announcements={Component.announcements}
          >
            {Component.InnerLayout ? <Component.InnerLayout>{page}</Component.InnerLayout> : page}
          </AppLayout>
        )}
      </BrowsingLevelProviderOptional>
    </FeatureLayout>
  );

  return (
    <AppProvider seed={seed} canIndex={canIndex}>
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
                          <SignalProvider>
                            <ActivityReportingProvider>
                              <ReferralsProvider {...cookies.referrals}>
                                <FiltersProvider>
                                  <AdsProvider>
                                    <PaddleProvider>
                                      <HiddenPreferencesProvider>
                                        <CivitaiLinkProvider>
                                          <NotificationsProvider
                                            className="notifications-container"
                                            zIndex={9999}
                                          >
                                            <BrowserRouterProvider>
                                              <IntersectionObserverProvider>
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
                                              </IntersectionObserverProvider>
                                            </BrowserRouterProvider>
                                          </NotificationsProvider>
                                        </CivitaiLinkProvider>
                                      </HiddenPreferencesProvider>
                                    </PaddleProvider>
                                  </AdsProvider>
                                </FiltersProvider>
                              </ReferralsProvider>
                            </ActivityReportingProvider>
                          </SignalProvider>
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

MyApp.getInitialProps = async (appContext: AppContext) => {
  const initialProps = await App.getInitialProps(appContext);
  const request = appContext.ctx.req;
  if (!request) return initialProps;

  // const url = appContext.ctx?.req?.url;

  const { pageProps, ...appProps } = initialProps;
  const colorScheme = getCookie('mantine-color-scheme', appContext.ctx) ?? 'dark';
  const cookies = getCookies(appContext.ctx);
  const parsedCookies = parseCookies(cookies);

  const hasAuthCookie = Object.keys(cookies).some((x) => x.endsWith('civitai-token'));
  // const session = hasAuthCookie ? await getSession(appContext.ctx) : undefined;
  // const flags = getFeatureFlags({ user: session?.user, host: appContext.ctx.req?.headers.host });
  const flags = getFeatureFlags({ host: request?.headers.host });
  const canIndex = Object.values(serverDomainMap).includes(request.headers.host);
  const token = await getToken({
    req: appContext.ctx.req as any,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName: civitaiTokenCookieName,
  });

  const session = token?.user ? { user: token.user } : null;
  // Pass this via the request so we can use it in SSR
  if (session) {
    (appContext.ctx.req as any)['session'] = session;
    // (appContext.ctx.req as any)['flags'] = flags;
  }

  return {
    pageProps: {
      ...pageProps,
      colorScheme,
      cookies: parsedCookies,
      canIndex,
      // cookieKeys: Object.keys(cookies),
      session,
      flags,
      seed: Date.now(),
      hasAuthCookie,
    },
    ...appProps,
  };
};

export default trpc.withTRPC(MyApp);
