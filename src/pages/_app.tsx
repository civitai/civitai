// src/pages/_app.tsx
import { ColorScheme, ColorSchemeProvider, MantineProvider } from '@mantine/core';
import { NotificationsProvider } from '@mantine/notifications';
import { getCookie, setCookie } from 'cookies-next';
import type { NextPage } from 'next';
import type { AppContext, AppProps } from 'next/app';
import App from 'next/app';
import Head from 'next/head';
import type { Session } from 'next-auth';
import { SessionProvider } from 'next-auth/react';
import { ReactElement, ReactNode, useState } from 'react';

import { AppLayout } from '~/components/AppLayout/AppLayout';
import { trpc } from '~/utils/trpc';
import '~/styles/globals.css';
import { ModalsProvider } from '@mantine/modals';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { CustomModalsProvider } from './../providers/CustomModalsProvider';

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
        <title>Model Share</title>
        <meta name="viewport" content="minimum-scale=1, initial-scale=1, width=device-width" />
      </Head>

      <ColorSchemeProvider colorScheme={colorScheme} toggleColorScheme={toggleColorScheme}>
        <MantineProvider theme={{ colorScheme }} withGlobalStyles withNormalizeCSS>
          <CustomModalsProvider>
            <NotificationsProvider>
              <SessionProvider session={session}>
                {getLayout(<Component {...pageProps} />)}
              </SessionProvider>
            </NotificationsProvider>
          </CustomModalsProvider>
        </MantineProvider>
      </ColorSchemeProvider>
      {process.env.NODE_ENV == 'development' && <ReactQueryDevtools />}
    </>
  );
}

MyApp.getInitialProps = async (appContext: AppContext) => {
  const { pageProps, ...appProps } = await App.getInitialProps(appContext);

  return {
    pageProps: {
      ...pageProps,
      colorScheme: getCookie('mantine-color-scheme', appContext.ctx) || 'light',
    },
    ...appProps,
  };
};

export default trpc.withTRPC(MyApp);
