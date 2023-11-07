import React, { ComponentProps, useEffect, useMemo, useRef } from 'react';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import { useRouter } from 'next/router';
import { dialogs } from './routed-dialog-registry';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { resolveHref } from 'next/dist/shared/lib/router/router';
import { parse } from 'query-string';
import { QS } from '~/utils/qs';

type DialogKey = keyof typeof dialogs;

export function RoutedDialogProvider() {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const prevState = useRef<{ url: string; as: string }>();

  useEffect(() => {
    router.beforePopState((state) => {
      const previous = prevState.current;
      console.log({ state, previous });
      if (state.url.includes('dialog') || previous?.url.includes('dialog')) return false;
      return true;
    });
  }, [router]);

  useEffect(() => {
    const names = ([] as DialogKey[]).concat((browserRouter.query.dialog as any) ?? []);
    prevState.current = { url: history.state.url, as: history.state.as };
    const openDialogs = useDialogStore
      .getState()
      .dialogs.filter((x) => x.type === 'routed-dialog')
      .map((x) => x.id as DialogKey);
    const toClose = openDialogs.filter((id) => !names.includes(id));
    const toOpen = names.filter((name) => !openDialogs.includes(name));

    for (const name of toOpen) {
      const sessionState = sessionStorage.getItem(name);
      const state = sessionState ? JSON.parse(sessionState) : undefined;
      dialogStore.trigger({
        id: name,
        component: dialogs[name].component,
        props: state,
        options: { onClose: () => history.go(-1) },
        type: 'routed-dialog',
      });
    }

    for (const name of toClose) {
      dialogStore.closeById(name);
    }
  }, [browserRouter.query]);

  return null;
}

// export function triggerRoutedDialog<T extends DialogKey>({
//   name,
//   state,
// }: {
//   name: T;
//   state: ComponentProps<(typeof dialogs)[T]['component']>;
// }) {}

export function RoutedDialogLink<T extends DialogKey>({
  name,
  state,
  children,
}: {
  name: T;
  state: ComponentProps<(typeof dialogs)[T]['component']>;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const dialog = dialogs[name];
  if (!dialog) throw new Error('invalid dialog name');

  const {
    url,
    asPath,
    state: routerState,
  } = useMemo(() => {
    return dialog.resolve(browserRouter.query, state);
  }, [browserRouter.query]); // eslint-disable-line

  const handleClick = (e: any) => {
    e.preventDefault();
    let _url = resolveHref(router, url);
    const [path, queryString] = _url.split('?');
    const query = {
      ...parse(queryString),
      ...browserRouter.query,
      dialog: ([] as DialogKey[]).concat((browserRouter.query.dialog as any) ?? []).concat(name),
    };
    _url = `${path}?${QS.stringify(query)}`;

    browserRouter.push(_url, asPath);
    if (routerState) sessionStorage.setItem(name, JSON.stringify(routerState));

    // const popStateEvent = new PopStateEvent('popstate', {
    //   state: {
    //     ...history.state,
    //     url: `${as}?${QS.stringify(parsedQuery)}`,
    //     as: href,
    //   },
    // });
    // dispatchEvent(popStateEvent);
  };

  const href = typeof asPath === 'string' ? asPath : resolveHref(router, asPath ?? url);

  return (
    <a href={href} onClick={handleClick}>
      {children}
    </a>
  );
}
