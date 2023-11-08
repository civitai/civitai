import Router, { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useState } from 'react';
import { UrlObject } from 'url';
import { resolveHref } from 'next/dist/shared/lib/router/router';
import { QS } from '~/utils/qs';
import { create } from 'zustand';
import { useDidUpdate } from '@mantine/hooks';

type Url = UrlObject | string;

const BrowserRouterContext = createContext<{
  asPath: string;
  query: Record<string, any>;
  push: (url: Url, as?: Url) => void;
  replace: (url: Url, as?: Url) => void;
  back: () => void;
} | null>(null);

export const useBrowserRouter = () => {
  const context = useContext(BrowserRouterContext); //eslint-disable-line
  if (!context) throw new Error('missing context');
  return context;
};

export function BrowserRouterProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const parseQuery = (state?: any) => {
    if (!state && typeof window === 'undefined') return {};
    const [path, queryString] = (state?.url ?? history.state.url).split('?');
    return QS.parse(queryString) as Record<string, any>;
  };

  const {
    asPath = router.asPath,
    query = parseQuery({ url: `${router.pathname}?${QS.stringify(router.query)}` }),
    setState,
  } = useBrowserRouterState();

  useDidUpdate(() => {
    setState({ asPath: history.state.as, query: parseQuery() });
  }, [router]); //eslint-disable-line

  useEffect(() => {
    const popstateFn = (e: PopStateEvent) =>
      dispatchEvent(new CustomEvent('locationchange', { detail: [e.state] }));
    const locationChangeFn = (e: Event) => {
      const event = e as CustomEvent;
      const state = event.detail[0];
      setState({ asPath: state.as, query: parseQuery(state) });
    };

    addEventListener('popstate', popstateFn);
    addEventListener('locationchange', locationChangeFn);
    return () => {
      removeEventListener('popstate', popstateFn);
      removeEventListener('locationchange', locationChangeFn);
    };
  }, []);

  return (
    <BrowserRouterContext.Provider value={{ asPath, query, ...browserRouterControls }}>
      {children}
    </BrowserRouterContext.Provider>
  );
}

const goto = (type: 'replace' | 'push', url: Url, as?: Url) => {
  const [_url, _urlAs] = resolveHref(Router, url, true);
  const [, _as] = as ? resolveHref(Router, as, true) : [_url, _urlAs];

  const historyState = {
    ...history.state,
    url: _url,
    as: _as,
  };

  type === 'replace'
    ? history.replaceState(historyState, '', _as)
    : history.pushState(historyState, '', _as);

  window.dispatchEvent(new CustomEvent('locationchange', { detail: [historyState] }));
};

const browserRouterControls = {
  push: (url: Url, as?: Url) => goto('push', url, as),
  replace: (url: Url, as?: Url) => goto('replace', url, as),
  back: () => history.go(-1),
};

const useBrowserRouterState = create<{
  asPath?: string;
  query?: Record<string, any>;
  setState: (args: { asPath?: string; query?: Record<string, any> }) => void;
}>((set) => ({
  setState: (args) => set(({ setState, ...state }) => ({ ...setState, ...args })),
}));

export const getBrowserRouter = () => {
  const { query = Router.query, asPath = Router.asPath } = useBrowserRouterState.getState();
  return { query, asPath, ...browserRouterControls };
};
