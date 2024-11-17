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
import { init as linkifyInit, registerCustomProtocol } from 'linkifyjs';
import type { Session } from 'next-auth';
import { getSession, SessionProvider } from 'next-auth/react';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import React, { ReactElement } from 'react';
import { AdsProvider } from '~/components/Ads/AdsProvider';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { BaseLayout } from '~/components/AppLayout/BaseLayout';
import { CustomNextPage } from '~/components/AppLayout/Page';
import { BrowserRouterProvider } from '~/components/BrowserRouter/BrowserRouterProvider';
// import ChadGPT from '~/components/ChadGPT/ChadGPT';
import { ChatContextProvider } from '~/components/Chat/ChatProvider';
import { CivitaiLinkProvider } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { AccountProvider } from '~/components/CivitaiWrapped/AccountProvider';
import { CivitaiSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { RoutedDialogProvider } from '~/components/Dialog/RoutedDialogProvider';
import { HiddenPreferencesProvider } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
// import { RecaptchaWidgetProvider } from '~/components/Recaptcha/RecaptchaWidget';
import { ReferralsProvider } from '~/components/Referrals/ReferralsProvider';
import { RouterTransition } from '~/components/RouterTransition/RouterTransition';
import { SignalProvider } from '~/components/Signals/SignalsProvider';
import { isDev } from '~/env/other';
import { ActivityReportingProvider } from '~/providers/ActivityReportingProvider';
import { CookiesProvider } from '~/providers/CookiesProvider';
import { CustomModalsProvider } from '~/providers/CustomModalsProvider';
// import { ImageProcessingProvider } from '~/components/ImageProcessing';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { FiltersProvider } from '~/providers/FiltersProvider';
import { IsClientProvider } from '~/providers/IsClientProvider';
// import { PaypalProvider } from '~/providers/PaypalProvider';
// import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { parseCookies, ParsedCookies } from '~/shared/utils';
import { RegisterCatchNavigation } from '~/store/catch-navigation.store';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
import { trpc } from '~/utils/trpc';
import '~/styles/globals.css';
import { FeatureLayout } from '~/components/AppLayout/FeatureLayout';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { PaddleProvider } from '~/providers/PaddleProvider';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
import { TrackPageView } from '~/components/TrackView/TrackPageView';
import { UpdateRequiredWatcher } from '~/components/UpdateRequiredWatcher/UpdateRequiredWatcher';
import { AppProvider } from '~/providers/AppProvider';
import { GoogleAnalytics } from '~/providers/GoogleAnalytics';

dayjs.extend(duration);
dayjs.extend(isBetween);
dayjs.extend(minMax);
dayjs.extend(relativeTime);
dayjs.extend(utc);

registerCustomProtocol('civitai', true);
// registerCustomProtocol('urn', true);
// TODO fix this from initializing again in dev
linkifyInit();

type CustomAppProps = {
  Component: CustomNextPage;
} & AppProps<{
  session: Session | null;
  colorScheme: ColorScheme;
  cookies: ParsedCookies;
  flags?: FeatureAccess;
  seed: number;
  hasAuthCookie: boolean;
}>;

function MyApp(props: CustomAppProps) {
  const {
    Component,
    pageProps: {
      session,
      colorScheme,
      cookies,
      flags,
      seed = Date.now(),
      hasAuthCookie,
      ...pageProps
    },
  } = props;

  if (typeof window !== 'undefined' && !window.authChecked) {
    window.authChecked = true;
    window.isAuthed = !!session;
  }

  // const getLayout =
  //   Component.getLayout ??
  //   ((page: ReactElement) => {
  //     const InnerLayout = Component.options?.InnerLayout ?? Component.options?.innerLayout;
  //     return (
  //       <FeatureLayout conditional={Component.options?.features}>
  //         <AppLayout>{InnerLayout ? <InnerLayout>{page}</InnerLayout> : page}</AppLayout>
  //       </FeatureLayout>
  //     );
  //   });

  const getLayout = (page: ReactElement) => (
    <FeatureLayout conditional={Component?.features}>
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
    </FeatureLayout>
  );

  return (
    <AppProvider seed={seed}>
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
                <CookiesProvider value={cookies}>
                  <AccountProvider>
                    <CivitaiSessionProvider>
                      <BrowserSettingsProvider>
                        <SignalProvider>
                          <ActivityReportingProvider>
                            <ReferralsProvider>
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
                                            <GenerationProvider>
                                              <IntersectionObserverProvider>
                                                <BaseLayout>
                                                  <TrackPageView />
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
                                            </GenerationProvider>
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
                      </BrowserSettingsProvider>
                    </CivitaiSessionProvider>
                  </AccountProvider>
                </CookiesProvider>
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

MyApp.getInitialProps = async (appContext: AppContext) => {
  const initialProps = await App.getInitialProps(appContext);
  if (!appContext.ctx.req) return initialProps;

  // const url = appContext.ctx?.req?.url;
  // const isClient = !url || url?.startsWith('/_next/data');

  const { pageProps, ...appProps } = initialProps;
  const colorScheme = getCookie('mantine-color-scheme', appContext.ctx) ?? 'dark';
  const cookies = getCookies(appContext.ctx);
  const parsedCookies = parseCookies(cookies);

  const hasAuthCookie = Object.keys(cookies).some((x) => x.endsWith('civitai-token'));
  // const session = hasAuthCookie ? await getSession(appContext.ctx) : undefined;
  // const flags = getFeatureFlags({ user: session?.user, host: appContext.ctx.req?.headers.host });
  const flags = getFeatureFlags({ host: appContext.ctx.req?.headers.host });

  // // Pass this via the request so we can use it in SSR
  // if (session) {
  //   (appContext.ctx.req as any)['session'] = session;
  //   // (appContext.ctx.req as any)['flags'] = flags;
  // }

  return {
    pageProps: {
      ...pageProps,
      colorScheme,
      cookies: parsedCookies,
      // cookieKeys: Object.keys(cookies),
      // session,
      flags,
      seed: Date.now(),
      hasAuthCookie,
    },
    ...appProps,
  };
};

export default trpc.withTRPC(MyApp);
