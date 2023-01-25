// src/pages/_app.tsx
import { ColorScheme, ColorSchemeProvider, MantineProvider } from '@mantine/core';
import { NotificationsProvider } from '@mantine/notifications';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getCookie, getCookies, setCookie } from 'cookies-next';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { NextPage } from 'next';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import type { Session } from 'next-auth';
import { getSession, SessionProvider } from 'next-auth/react';
import { ReactElement, ReactNode, useState } from 'react';

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
import { NavigateBackProvider } from '~/providers/NavigateBackProvider';

dayjs.extend(duration);
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

  const toggleColorScheme = (value?: ColorScheme) => {
    const nextColorScheme = value || (colorScheme === 'dark' ? 'light' : 'dark');
    setColorScheme(nextColorScheme);
    setCookie('mantine-color-scheme', nextColorScheme, {
      expires: dayjs().add(1, 'year').toDate(),
    });
  };

  const getLayout = Component.getLayout ?? ((page) => <AppLayout>{page}</AppLayout>);
  const content = env.NEXT_PUBLIC_MAINTENANCE_MODE ? (
    <MaintenanceMode />
  ) : (
    <NavigateBackProvider>
      <SessionProvider session={session}>
        <CookiesProvider value={cookies}>
          <FeatureFlagsProvider flags={flags}>
            <NsfwWorkerProvider>
              <CustomModalsProvider>
                <NotificationsProvider>
                  <RoutedContextProvider>
                    <TosProvider>{getLayout(<Component {...pageProps} />)}</TosProvider>
                  </RoutedContextProvider>
                </NotificationsProvider>
              </CustomModalsProvider>
            </NsfwWorkerProvider>
          </FeatureFlagsProvider>
        </CookiesProvider>
      </SessionProvider>
    </NavigateBackProvider>
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
  const { pageProps, ...appProps } = await App.getInitialProps(appContext);
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
        session,
        colorScheme: getCookie('mantine-color-scheme', appContext.ctx) ?? 'light',
        cookies: parsedCookies,
        flags,
      },
      ...appProps,
    };
  }
};

export default trpc.withTRPC(MyApp);
