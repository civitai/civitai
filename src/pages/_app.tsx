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
import type { NextPage } from 'next';
import type { Session } from 'next-auth';
import { getSession, SessionProvider } from 'next-auth/react';
import PlausibleProvider from 'next-plausible';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import React, { ReactElement, ReactNode } from 'react';
import { AdsProvider } from '~/components/Ads/AdsProvider';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { BaseLayout } from '~/components/AppLayout/BaseLayout';
import { InnerLayoutOptions } from '~/components/AppLayout/createPage';
import { BrowserRouterProvider } from '~/components/BrowserRouter/BrowserRouterProvider';
import { BrowsingModeProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import ChadGPT from '~/components/ChadGPT/ChadGPT';
import { ChatContextProvider } from '~/components/Chat/ChatProvider';
import { CivitaiLinkProvider } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { AccountProvider } from '~/components/CivitaiWrapped/AccountProvider';
import { CivitaiSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { RoutedDialogProvider } from '~/components/Dialog/RoutedDialogProvider';
import { HiddenPreferencesProvider } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { MetaPWA } from '~/components/Meta/MetaPWA';
import { RecaptchaWidgetProvider } from '~/components/Recaptcha/RecaptchaWidget';
import { ReferralsProvider } from '~/components/Referrals/ReferralsProvider';
import { RouterTransition } from '~/components/RouterTransition/RouterTransition';
import { ScrollAreaMain } from '~/components/ScrollArea/ScrollAreaMain';
import { SignalProvider } from '~/components/Signals/SignalsProvider';
import { UpdateRequiredWatcher } from '~/components/UpdateRequiredWatcher/UpdateRequiredWatcher';
import { isDev } from '~/env/other';
import { CivitaiPosthogProvider } from '~/hooks/usePostHog';
import { ActivityReportingProvider } from '~/providers/ActivityReportingProvider';
import { CookiesProvider } from '~/providers/CookiesProvider';
import { CustomModalsProvider } from '~/providers/CustomModalsProvider';
// import { ImageProcessingProvider } from '~/components/ImageProcessing';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { FiltersProvider } from '~/providers/FiltersProvider';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { PaypalProvider } from '~/providers/PaypalProvider';
import { StripeSetupSuccessProvider } from '~/providers/StripeProvider';
import { ThemeProvider } from '~/providers/ThemeProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { parseCookies, ParsedCookies } from '~/shared/utils';
import { RegisterCatchNavigation } from '~/store/catch-navigation.store';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
import { trpc } from '~/utils/trpc';
import '~/styles/globals.css';

dayjs.extend(duration);
dayjs.extend(isBetween);
dayjs.extend(minMax);
dayjs.extend(relativeTime);
dayjs.extend(utc);

registerCustomProtocol('civitai', true);
// registerCustomProtocol('urn', true);
linkifyInit();

type CustomNextPage = NextPage & {
  getLayout?: (page: ReactElement) => ReactNode;
  options?: InnerLayoutOptions;
};

type CustomAppProps = {
  Component: CustomNextPage;
} & AppProps<{
  session: Session | null;
  colorScheme: ColorScheme;
  cookies: ParsedCookies;
  flags: FeatureAccess;
}>;

function MyApp(props: CustomAppProps) {
  const {
    Component,
    pageProps: { session, colorScheme, cookies, flags, ...pageProps },
  } = props;

  if (typeof window !== 'undefined' && !window.authChecked) {
    window.authChecked = true;
    window.isAuthed = !!session;
  }

  const getLayout =
    Component.getLayout ??
    ((page: ReactElement) => {
      const InnerLayout = Component.options?.InnerLayout ?? Component.options?.innerLayout;
      const withScrollArea = Component.options?.withScrollArea ?? true;
      return (
        <AppLayout>
          {/* <InnerLayout>
            {withScrollArea ? <ScrollAreaMain>{page}</ScrollAreaMain> : page}
          </InnerLayout> */}
          {InnerLayout ? (
            <InnerLayout>{page}</InnerLayout>
          ) : withScrollArea ? (
            <ScrollAreaMain>{page}</ScrollAreaMain>
          ) : (
            page
          )}
        </AppLayout>
      );
    });

  return (
    <>
      <Head>
        <title>Civitai | Share your models</title>
        <MetaPWA />
      </Head>
      <ThemeProvider colorScheme={colorScheme}>
        {/* <ErrorBoundary> */}
        <PlausibleProvider
          domain="civitai.com"
          customDomain="https://analytics.civitai.com"
          selfHosted
        >
          <IsClientProvider>
            <ClientHistoryStore />
            <RegisterCatchNavigation />
            <RouterTransition />
            <UpdateRequiredWatcher />
            <ChadGPT isAuthed={!!session} />
            <SessionProvider
              session={session}
              refetchOnWindowFocus={false}
              refetchWhenOffline={false}
            >
              <FeatureFlagsProvider flags={flags}>
                <CookiesProvider value={cookies}>
                  <BrowsingModeProvider>
                    <AccountProvider>
                      <CivitaiSessionProvider>
                        <SignalProvider>
                          <ActivityReportingProvider>
                            <CivitaiPosthogProvider>
                              <ReferralsProvider>
                                <FiltersProvider>
                                  <AdsProvider>
                                    <PaypalProvider>
                                      <HiddenPreferencesProvider>
                                        <CivitaiLinkProvider>
                                          <NotificationsProvider
                                            className="notifications-container"
                                            zIndex={9999}
                                          >
                                            <BrowserRouterProvider>
                                              <RecaptchaWidgetProvider>
                                                <ChatContextProvider>
                                                  <BaseLayout>
                                                    <CustomModalsProvider>
                                                      {getLayout(<Component {...pageProps} />)}
                                                      <StripeSetupSuccessProvider />
                                                      <DialogProvider />
                                                      <RoutedDialogProvider />
                                                    </CustomModalsProvider>
                                                  </BaseLayout>
                                                </ChatContextProvider>
                                              </RecaptchaWidgetProvider>
                                            </BrowserRouterProvider>
                                          </NotificationsProvider>
                                        </CivitaiLinkProvider>
                                      </HiddenPreferencesProvider>
                                    </PaypalProvider>
                                  </AdsProvider>
                                </FiltersProvider>
                              </ReferralsProvider>
                            </CivitaiPosthogProvider>
                          </ActivityReportingProvider>
                        </SignalProvider>
                      </CivitaiSessionProvider>
                    </AccountProvider>
                  </BrowsingModeProvider>
                </CookiesProvider>
              </FeatureFlagsProvider>
            </SessionProvider>
          </IsClientProvider>
        </PlausibleProvider>
        {/* </ErrorBoundary> */}
      </ThemeProvider>

      {isDev && <ReactQueryDevtools />}
    </>
  );
}

MyApp.getInitialProps = async (appContext: AppContext) => {
  const initialProps = await App.getInitialProps(appContext);
  const url = appContext.ctx?.req?.url;
  const isClient = !url || url?.startsWith('/_next/data');

  const { pageProps, ...appProps } = initialProps;
  const colorScheme = getCookie('mantine-color-scheme', appContext.ctx) ?? 'dark';
  const cookies = getCookies(appContext.ctx);
  const parsedCookies = parseCookies(cookies);

  const hasAuthCookie = !isClient && Object.keys(cookies).some((x) => x.endsWith('civitai-token'));
  const session = hasAuthCookie ? await getSession(appContext.ctx) : null;
  const flags = getFeatureFlags({ user: session?.user });

  // Pass this via the request so we can use it in SSR
  if (session) {
    (appContext.ctx.req as any)['session'] = session;
    (appContext.ctx.req as any)['flags'] = flags;
  }

  return {
    pageProps: {
      ...pageProps,
      colorScheme,
      cookies: parsedCookies,
      session,
      flags,
    },
    ...appProps,
  };
};

export default trpc.withTRPC(MyApp);
