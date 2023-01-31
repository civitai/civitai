// src/pages/_app.tsx
import { ColorScheme, ColorSchemeProvider, MantineProvider } from '@mantine/core';
import { NotificationsProvider } from '@mantine/notifications';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getCookie, getCookies, setCookie } from 'cookies-next';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import isBetween from 'dayjs/plugin/isBetween';
import minMax from 'dayjs/plugin/minMax';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { NextPage } from 'next';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import type { Session } from 'next-auth';
import { getSession, SessionProvider } from 'next-auth/react';
import { ReactElement, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { AppLayout } from '~/components/AppLayout/AppLayout';
import { trpc } from '~/utils/trpc';
import '~/styles/globals.css';
import { CustomModalsProvider } from './../providers/CustomModalsProvider';
import { TosProvider } from '~/providers/TosProvider';
import { CookiesContext, CookiesProvider, parseCookies } from '~/providers/CookiesProvider';
import { RoutedContextProvider } from '~/routed-context/routed-context.provider';
import { env } from '~/env/client.mjs';
import { MaintenanceMode } from '~/components/MaintenanceMode/MaintenanceMode';
import { NsfwWorkerProvider } from '~/providers/NsfwWorkerProvider';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import type { FeatureFlags } from '~/server/services/feature-flags.service';
import { ClientHistoryStore } from '~/store/ClientHistoryStore';
import { RoutedContextProvider2 } from '~/providers/RoutedContextProvider';

dayjs.extend(duration);
dayjs.extend(isBetween);
dayjs.extend(minMax);
dayjs.extend(relativeTime);

type CustomNextPage = NextPage & {
  getLayout?: (page: ReactElement) => ReactNode;
};

type CustomAppProps = {
  Component: CustomNextPage;
} & AppProps<{
  session: Session | null;
  colorScheme: ColorScheme;
  cookies: CookiesContext;
  flags: FeatureFlags;
}>;

function MyApp(props: CustomAppProps) {
  const {
    Component,
    pageProps: { session, colorScheme: initialColorScheme, cookies, flags, ...pageProps },
  } = props;
  const [colorScheme, setColorScheme] = useState<ColorScheme>(initialColorScheme);
  const toggleColorScheme = useCallback(
    (value?: ColorScheme) => {
      const nextColorScheme = value || (colorScheme === 'dark' ? 'light' : 'dark');
      setColorScheme(nextColorScheme);
      setCookie('mantine-color-scheme', nextColorScheme, {
        expires: dayjs().add(1, 'year').toDate(),
      });
    },
    [colorScheme]
  );

  const getLayout = useMemo(
    () => Component.getLayout ?? ((page: any) => <AppLayout>{page}</AppLayout>),
    [Component.getLayout]
  );

  useEffect(() => console.log('layout changed'), [toggleColorScheme]);
  const content = env.NEXT_PUBLIC_MAINTENANCE_MODE ? (
    <MaintenanceMode />
  ) : (
    <>
      <ClientHistoryStore />
      <SessionProvider session={session}>
        <CookiesProvider value={cookies}>
          <FeatureFlagsProvider flags={flags}>
            <NsfwWorkerProvider>
              <CustomModalsProvider>
                <NotificationsProvider>
                  {/* <RoutedContextProvider> */}
                  <TosProvider>{getLayout(<Component {...pageProps} />)}</TosProvider>
                  <RoutedContextProvider2 />
                  {/* </RoutedContextProvider> */}
                </NotificationsProvider>
              </CustomModalsProvider>
            </NsfwWorkerProvider>
          </FeatureFlagsProvider>
        </CookiesProvider>
      </SessionProvider>
    </>
  );

  return (
    <>
      <Head>
        <title>Civitai | Share your models</title>
        <meta name="viewport" content="maximum-scale=1, initial-scale=1, width=device-width" />
        <link rel="manifest" href="/site.webmanifest" />
      </Head>

      <ColorSchemeProvider colorScheme={colorScheme} toggleColorScheme={toggleColorScheme}>
        <MantineProvider
          theme={{
            colorScheme,
            components: {
              Modal: { styles: { modal: { maxWidth: '100%' } } },
              Popover: { styles: { dropdown: { maxWidth: '100vw' } } },
              Rating: { styles: { symbolBody: { cursor: 'pointer' } } },
              Switch: {
                styles: {
                  body: { verticalAlign: 'top' },
                  track: { cursor: 'pointer' },
                  label: { cursor: 'pointer' },
                },
              },
              Radio: {
                styles: {
                  radio: { cursor: 'pointer' },
                  label: { cursor: 'pointer' },
                },
              },
              Badge: {
                styles: { leftSection: { lineHeight: 1 } },
                defaultProps: { radius: 'sm' },
              },
            },
          }}
          withGlobalStyles
          withNormalizeCSS
        >
          {content}
        </MantineProvider>
      </ColorSchemeProvider>
      {process.env.NODE_ENV == 'development' && <ReactQueryDevtools />}
    </>
  );
}

MyApp.getInitialProps = async (appContext: AppContext) => {
  const initialProps = await App.getInitialProps(appContext);
  const isClient = appContext.ctx?.req?.url?.startsWith('/_next/data');
  if (isClient) return initialProps;

  const { pageProps, ...appProps } = initialProps;
  const colorScheme = getCookie('mantine-color-scheme', appContext.ctx) ?? 'light';
  const cookies = getCookies(appContext.ctx);
  const parsedCookies = parseCookies(cookies);

  if (env.NEXT_PUBLIC_MAINTENANCE_MODE) {
    return {
      pageProps: {
        ...pageProps,
        colorScheme,
        cookies: parsedCookies,
      },
      ...appProps,
    };
  } else {
    const session = await getSession(appContext.ctx);
    const flags = getFeatureFlags({ user: session?.user });
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
  }
};

export default trpc.withTRPC(MyApp);
