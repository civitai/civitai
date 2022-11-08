// src/pages/_app.tsx
import { ColorScheme, ColorSchemeProvider, MantineProvider } from '@mantine/core';
import { NotificationsProvider } from '@mantine/notifications';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { getCookie, setCookie } from 'cookies-next';
import * as dayjs from 'dayjs';
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

dayjs.extend(duration);
dayjs.extend(relativeTime);

type CustomNextPage = NextPage & {
  getLayout?: (page: ReactElement) => ReactNode;
};

type CustomAppProps<P> = AppProps<P> & {
  Component: CustomNextPage;
  colorScheme: ColorScheme;
};

function MyApp(props: CustomAppProps<{ session: Session | null; colorScheme: ColorScheme }>) {
  const {
    Component,
    pageProps: { session, colorScheme: initialColorScheme, ...pageProps },
  } = props;
  const [colorScheme, setColorScheme] = useState<ColorScheme>(initialColorScheme);

  const toggleColorScheme = (value?: ColorScheme) => {
    const nextColorScheme = value || (colorScheme === 'dark' ? 'light' : 'dark');
    setColorScheme(nextColorScheme);
    setCookie('mantine-color-scheme', nextColorScheme);
  };

  const getLayout = Component.getLayout ?? ((page) => <AppLayout>{page}</AppLayout>);

  return (
    <>
      <Head>
        <title>Civitai</title>
        <meta name="viewport" content="minimum-scale=1, initial-scale=1, width=device-width" />
      </Head>

      <SessionProvider session={session}>
        <ColorSchemeProvider colorScheme={colorScheme} toggleColorScheme={toggleColorScheme}>
          <MantineProvider theme={{ colorScheme }} withGlobalStyles withNormalizeCSS>
            <CustomModalsProvider>
              <NotificationsProvider>
                <TosProvider>{getLayout(<Component {...pageProps} />)}</TosProvider>
              </NotificationsProvider>
            </CustomModalsProvider>
          </MantineProvider>
        </ColorSchemeProvider>
      </SessionProvider>
      {process.env.NODE_ENV == 'development' && <ReactQueryDevtools />}
    </>
  );
}

MyApp.getInitialProps = async (appContext: AppContext) => {
  const { pageProps, ...appProps } = await App.getInitialProps(appContext);
  const session = await getSession(appContext.ctx);

  return {
    pageProps: {
      ...pageProps,
      session,
      colorScheme: getCookie('mantine-color-scheme', appContext.ctx) || 'light',
    },
    ...appProps,
  };
};

export default trpc.withTRPC(MyApp);
