import Router, { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useRef } from 'react';
import type { UrlObject } from 'url';
import { resolveHref } from 'next/dist/client/resolve-href';
import { QS } from '~/utils/qs';
import { create } from 'zustand';
import { useDidUpdate } from '@mantine/hooks';
import {
  resolveLocationChangeState,
  type BrowserRouterState,
  type HistoryState,
} from '~/components/BrowserRouter/browserRouterState';

type Url = UrlObject | string;

const BrowserRouterContext = createContext<{
  asPath: string;
  query: Record<string, any>;
  state: HistoryState;
  push: (url: Url, as?: Url, state?: Record<string, any>) => void;
  replace: (url: Url, as?: Url, state?: Record<string, any>) => void;
  back: () => void;
} | null>(null);

export const useBrowserRouter = () => {
  const context = useContext(BrowserRouterContext); //eslint-disable-line
  if (!context) throw new Error('missing context');
  return context;
};

export function BrowserRouterProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const stateRef = useRef<BrowserRouterState>();

  const {
    asPath = router.asPath,
    query = QS.parse(QS.stringify(router.query)),
    state = {} as HistoryState,
  } = useBrowserRouterState();

  useDidUpdate(() => {
    useBrowserRouterState.setState({
      asPath: router.asPath,
      query: QS.parse(QS.stringify(router.query)),
    });
  }, [router]); //eslint-disable-line

  useEffect(() => {
    const popstateFn = (e: PopStateEvent) =>
      dispatchEvent(new CustomEvent('locationchange', { detail: [e.state] }));

    const locationChangeFn = (e: Event) => {
      const event = e as CustomEvent;
      if (event.detail) {
        const eventState = event.detail[0];
        stateRef.current = resolveLocationChangeState(eventState, history.state, window.location);
        if (!usingNextRouter) useBrowserRouterState.setState(stateRef.current);
      }
    };

    addEventListener('popstate', popstateFn);
    addEventListener('locationchange', locationChangeFn);
    return () => {
      removeEventListener('popstate', popstateFn);
      removeEventListener('locationchange', locationChangeFn);
    };
  }, []);

  useEffect(() => {
    const handleRouteChangeComplete = () => {
      if (stateRef.current && stateRef.current?.asPath === history.state?.as)
        useBrowserRouterState.setState(stateRef.current);

      setUsingNextRouter(false);
    };

    router.events.on('routeChangeComplete', handleRouteChangeComplete);

    return () => {
      router.events.off('routeChangeComplete', handleRouteChangeComplete);
    };
  }, []); //eslint-disable-line

  return (
    <BrowserRouterContext.Provider value={{ asPath, query, state, ...browserRouterControls }}>
      {children}
    </BrowserRouterContext.Provider>
  );
}

function goto(type: 'replace' | 'push', url: Url, as?: Url, state?: HistoryState) {
  const [_url, _urlAs] = resolveHref(Router, url, true);
  const [, _as] = as ? resolveHref(Router, as, true) : [_url, _urlAs];

  const historyState = {
    ...history.state,
    state: { ...(history.state?.state ?? {}), ...state },
    // key: uuidv4(),
    url: _url,
    as: _as,
  };

  if (type === 'replace') {
    history.replaceState(historyState, '', _as);
  } else {
    const { as } = history.state ?? {};
    historyState.state.prev = { asPath: as };
    history.pushState(historyState, '', _as);
  }

  window.dispatchEvent(new CustomEvent('locationchange', { detail: [historyState] }));
}

const browserRouterControls = {
  push: (url: Url, as?: Url, state?: HistoryState) => goto('push', url, as, state),
  replace: (url: Url, as?: Url, state?: HistoryState) => goto('replace', url, as, state),
  back: () => history.go(-1),
};

const useBrowserRouterState = create<{
  asPath?: string;
  query?: Record<string, any>;
  state?: HistoryState;
}>(() => ({}));

export const getBrowserRouter = () => {
  const isClient = typeof window !== 'undefined';
  const {
    query = isClient ? Router.query : undefined,
    asPath = isClient ? Router.asPath : undefined,
  } = useBrowserRouterState.getState();
  return { query, asPath, ...browserRouterControls };
};

let usingNextRouter = false;
export const setUsingNextRouter = (value: boolean) => {
  usingNextRouter = value;
};
