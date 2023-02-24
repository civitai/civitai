import { useDidUpdate, useWindowEvent } from '@mantine/hooks';
import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useMemo } from 'react';
import Router, { NextRouter, useRouter } from 'next/router';
import { ParsedUrlQuery } from 'querystring';
import createContext from 'zustand/context';

type InitialProps = {
  asPath: string;
  basePath: string;
  pathname: string;
  query: ParsedUrlQuery;
  route: string;
};

type RouterStoreProps = InitialProps & {
  update: (router: NextRouter) => void;
};

// export const useRouterStore = create<RouterStoreProps>()(
//   immer((set) => ({
//     asPath: isClient ? Router.asPath : (undefined as any),
//     basePath: isClient ? Router.basePath : (undefined as any),
//     pathname: isClient ? Router.pathname : (undefined as any),
//     query: isClient ? Router.query : (undefined as any),
//     route: isClient ? Router.route : (undefined as any),
//     update: (router) => {
//       set((state) => {
//         state.asPath = router.asPath;
//         state.basePath = router.basePath;
//         state.pathname = router.pathname;
//         state.query = router.query;
//         state.route = router.route;
//       });
//     },
//   }))
// );

const { Provider, useStore } = createContext<ReturnType<typeof createMyStore>>();
const createMyStore = (initialState: InitialProps) =>
  create<RouterStoreProps>()(
    immer((set) => ({
      ...initialState,
      update: (router) => {
        set((state) => {
          state.asPath = router.asPath;
          state.basePath = router.basePath;
          state.pathname = router.pathname;
          state.query = router.query;
          state.route = router.route;
        });
      },
    }))
  );

export function RouterStoreProvider({
  children,
  value,
}: {
  children: React.ReactElement;
  value: NextRouter;
}) {
  return (
    <Provider
      createStore={() =>
        createMyStore({
          asPath: value.asPath,
          basePath: value.basePath,
          pathname: value.pathname,
          query: value.query,
          route: value.route,
        })
      }
    >
      <RouterStore />
      {children}
    </Provider>
  );
}

function RouterStore() {
  // const router = useRouter();
  const update = useStore((state) => state.update);

  useEffect(() => {
    const handleRouteChangeComplete = () => update(Router);
    Router.events.on('routeChangeComplete', handleRouteChangeComplete);
    return () => {
      Router.events.off('routeChangeComplete', handleRouteChangeComplete);
    };
  }, []); //eslint-disable-line

  return null;
}

export const useRouterStore = useStore;
