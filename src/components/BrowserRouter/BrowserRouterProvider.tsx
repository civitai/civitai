import Router, { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useState } from 'react';
import { UrlObject } from 'url';
import { resolveHref } from 'next/dist/shared/lib/router/router';
import { QS } from '~/utils/qs';

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
    if (typeof window === 'undefined') return {};
    const [path, queryString] = (state?.url ?? history.state.url).split('?');
    return QS.parse(queryString) as Record<string, any>;
  };

  const [asPath, setAsPath] = useState<string>(router.asPath);
  const [query, setQuery] = useState<Record<string, any>>({
    url: `${router.pathname}?${QS.stringify(router.query)}`,
  });

  useEffect(() => {
    setQuery(parseQuery());
    setAsPath(history.state.as);
  }, [router]);

  useEffect(() => {
    const popstateFn = (e: PopStateEvent) =>
      dispatchEvent(new CustomEvent('locationchange', { detail: [e.state] }));
    const locationChangeFn = (e: Event) => {
      const event = e as CustomEvent;
      const state = event.detail[0];
      setQuery(parseQuery(state));
      setAsPath(state.as);
    };

    addEventListener('popstate', popstateFn);
    addEventListener('locationchange', locationChangeFn);
    return () => {
      removeEventListener('popstate', popstateFn);
      removeEventListener('locationchange', locationChangeFn);
    };
  }, []);

  const goto = (type: 'replace' | 'push', url: Url, as?: Url) => {
    const _url = resolveHref(Router, url);
    const _as = as ? resolveHref(Router, as) : _url;

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

  const push = (url: Url, as?: Url) => goto('push', url, as);
  const replace = (url: Url, as?: Url) => goto('replace', url, as);
  const back = () => history.go(-1);

  return (
    <BrowserRouterContext.Provider value={{ asPath, push, query, replace, back }}>
      {children}
    </BrowserRouterContext.Provider>
  );
}
