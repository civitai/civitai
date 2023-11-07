import Router from 'next/router';
import { createContext, useContext, useEffect, useState } from 'react';
import { UrlObject } from 'url';
import { resolveHref } from 'next/dist/shared/lib/router/router';
import { parse } from 'query-string';

type Url = UrlObject | string;

const BrowserRouterContext = createContext<{
  // asPath: string;
  query: Record<string, string | string[]>;
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
  const parseQuery = (url?: string) => {
    if (typeof window === 'undefined') return {};
    const [path, queryString] = (url ?? history.state.url).split('?');
    return parse(queryString) as Record<string, string | string[]>;
  };
  // const [asPath, setAsPath] = useState<string>('')
  const [query, setQuery] = useState<Record<string, string | string[]>>(parseQuery());

  useEffect(() => {
    const listener = () => {
      setQuery(parseQuery());
    };
    addEventListener('popstate', listener);
    return () => {
      removeEventListener('popstate', listener);
    };
  }, []);

  const goto = (type: 'replace' | 'push', url: Url, as?: Url) => {
    const cb = type === 'replace' ? history.replaceState : history.pushState;

    const _url = resolveHref(Router, url);
    const _as = as ? resolveHref(Router, as) : _url;

    setQuery(parseQuery(_url));

    cb(
      {
        ...history.state,
        options: { ...history.state.options },
        url: _url,
        as: _as,
      },
      '',
      _as
    );
  };

  const push = (url: Url, as?: Url) => goto('push', url, as);
  const replace = (url: Url, as?: Url) => goto('replace', url, as);
  const back = () => history.go(-1);

  // const mutateHistoryState(type: 'push' | 'replace', state:any)

  // TODO - push
  // TODO - replace
  // TODO - back

  // function push<T>(url: Url, as?: Url, state?: T) {}

  return (
    <BrowserRouterContext.Provider value={{ push, query, replace, back }}>
      {children}
    </BrowserRouterContext.Provider>
  );
}
