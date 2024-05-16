import React, { ComponentProps, ComponentType, cloneElement, useEffect, useRef } from 'react';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import Router, { useRouter } from 'next/router';
import { dialogs } from './routed-dialog-registry';
import {
  setUsingNextRouter,
  getBrowserRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import { NextRouter, resolveHref } from 'next/dist/shared/lib/router/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { QS } from '~/utils/qs';
import { getHasClientHistory } from '~/store/ClientHistoryStore';

type DialogKey = keyof typeof dialogs;

export function RoutedDialogProvider() {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const prevState = useRef<{ url: string; as: string }>();
  const currentUser = useCurrentUser();

  // handle next router popstate
  useEffect(() => {
    router.beforePopState((state) => {
      const previous = prevState.current;
      setUsingNextRouter(true);

      // it's magic...
      if (!state.url.includes('dialog') && router.asPath.split('?')[0] !== state.as.split('?')[0]) {
        return true;
      }
      if (state.url.includes('dialog') || previous?.url.includes('dialog')) {
        setUsingNextRouter(false);
        return false;
      }
      return true;
    });
  }, [router]);

  /*
    this handles the case of a user clicking a next link
    to the same url from which they opened their dialog
  */
  useEffect(() => {
    const handleRouteChangeStart = (asPath: string) => {
      if (router.asPath === asPath && prevState.current?.url.includes('dialog')) {
        browserRouter.push({ query: router.query });
        throw 'nextjs route change aborted';
      }
    };
    router.events.on('routeChangeStart', handleRouteChangeStart);
    return () => {
      router.events.off('routeChangeStart', handleRouteChangeStart);
    };
  }, [router]); // eslint-disable-line

  useEffect(() => {
    const counts = {} as Record<DialogKey, number>;
    const names = ([] as DialogKey[]).concat((browserRouter.query.dialog as any) ?? []);
    const keyNamePairs = names.map((name) => {
      if (!counts[name]) counts[name] = 1;
      else counts[name] += 1;

      return {
        name: name as DialogKey,
        key: `${name}_${counts[name]}`,
      };
    });
    prevState.current = history.state;
    const openDialogs = useDialogStore
      .getState()
      .dialogs.filter((x) => x.type === 'routed-dialog')
      .map((x) => x.id);

    const toClose = openDialogs.filter((id) => !keyNamePairs.find((x) => id === x.key));
    const toOpen = keyNamePairs.filter((x) => !openDialogs.includes(x.name));

    for (const { key, name } of toOpen) {
      if (dialogs[name].requireAuth && !currentUser) continue;
      const state = history.state.state;
      const Dialog = createBrowserRouterSync(dialogs[name].component);
      dialogStore.trigger({
        id: key,
        component: Dialog,
        props: { ...browserRouter.query, ...state },
        options: { onClose: () => handleCloseRoutedDialog(name) },
        type: 'routed-dialog',
        target: dialogs[name].target,
      });
    }

    for (const key of toClose) {
      dialogStore.closeById(key);
    }
  }, [browserRouter.query, currentUser]);

  return null;
}

export function triggerRoutedDialog<T extends DialogKey>({
  name,
  state,
}: {
  name: T;
  state: ComponentProps<(typeof dialogs)[T]['component']>;
}) {
  const browserRouter = getBrowserRouter();
  const { url, asPath, state: sessionState } = resolveDialog(name, browserRouter.query, state);
  browserRouter.push(url, asPath, sessionState);
}

function handleCloseRoutedDialog<T extends DialogKey>(name: T) {
  const browserRouter = getBrowserRouter();
  const hasHistory = getHasClientHistory();
  if (!hasHistory) {
    const { dialog, ...query } = Router.query;
    const [pathname] = Router.asPath.split('?');
    Router.push({ pathname, query }, { pathname }, { shallow: true });
  } else {
    browserRouter.back();
  }
}

// export function closeLatestRoutedDialog() {
//   const browserRouter = getBrowserRouter();
//   const hasHistory = getHasClientHistory();
//   if (!hasHistory) {
//     const { dialog, ...query } = Router.query;
//     const [pathname] = Router.asPath.split('?');
//     Router.push({ pathname, query }, { pathname }, { shallow: true });
//   } else {
//     browserRouter.back();
//   }
// }

export function RoutedDialogLink<T extends DialogKey, TPassHref extends boolean = false>({
  name,
  state,
  children,
  className,
  passHref,
  style,
}: {
  name: T;
  state: ComponentProps<(typeof dialogs)[T]['component']>;
  passHref?: TPassHref;
  className?: string;
  children: TPassHref extends true ? React.ReactElement : React.ReactNode;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const { query = QS.parse(QS.stringify(router.query)) } = getBrowserRouter();
  const { asPath } = resolveDialog(name, query, state, router);

  const handleClick = (e: any) => {
    if (!e.ctrlKey) {
      e.preventDefault();
      // e.stopPropagation();
      triggerRoutedDialog({ name, state });
    }
  };

  if (passHref) {
    return cloneElement(children as React.ReactElement, {
      href: asPath,
      onClick: handleClick,
      // className,
      // style,
    });
  }

  return (
    <a href={asPath} onClick={handleClick} className={className} style={style}>
      {children}
    </a>
  );
}

function createBrowserRouterSync(Dialog: ComponentType<any>) {
  return function BrowserRouterSync(args: ComponentProps<ComponentType<any>>) {
    const { query, state } = useBrowserRouter();
    return <Dialog {...args} {...query} {...state} />;
  };
}

const getAsPath = (query: Record<string, any>, router: NextRouter) => {
  const matches = router.pathname.match(/\[([\.\w]+)\]/g);
  const params = { ...query };
  for (const key in params) {
    if (matches?.some((match) => match.includes(key))) delete params[key];
  }
  let asPath = router.asPath.split('?')[0];
  if (Object.keys(params).length > 0) asPath = `${asPath}?${QS.stringify(params)}`;
  return asPath;
};

function resolveDialog<T extends DialogKey>(
  name: T,
  query: Record<string, any> = {},
  state: ComponentProps<(typeof dialogs)[T]['component']>,
  router: NextRouter = Router
) {
  const dialog = dialogs[name];
  if (!dialog) throw new Error('invalid dialog name');

  const {
    query: resolvedQuery,
    asPath = getAsPath(resolvedQuery, router),
    state: _state,
  } = dialog.resolve(
    {
      ...query,
      dialog: ([] as DialogKey[]).concat(query.dialog ?? []).concat(name),
    },
    state
  ); // eslint-disable-line

  const [_url, _urlAs] = resolveHref(router, { query: resolvedQuery as any }, true);
  const [, _asPath] = asPath ? resolveHref(router, asPath, true) : [_url, _urlAs];
  // console.log({ _url, _urlAs, _asPath });

  return { url: _url, asPath: _asPath, state: _state };
}
