import React, { ComponentProps, ComponentType, cloneElement, useEffect, useRef } from 'react';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import Router, { useRouter } from 'next/router';
import { dialogs } from './routed-dialog-registry';
import {
  setUsingNextRouter,
  getBrowserRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import { resolveHref } from 'next/dist/shared/lib/router/router';

type DialogKey = keyof typeof dialogs;

export function RoutedDialogProvider() {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const prevState = useRef<{ url: string; as: string; pathname: string }>();

  useEffect(() => {
    router.beforePopState((state) => {
      const previous = prevState.current;
      setUsingNextRouter(true);

      // it's magic...
      if (!state.url.includes('dialog') && router.pathname !== state.url.split('?')[0]) {
        state.options.scroll = false;
        return true;
      }
      if (state.url.includes('dialog') || previous?.url.includes('dialog')) {
        setUsingNextRouter(false);
        return false;
      }
      state.options.scroll = undefined;
      return true;
    });
  }, [router]);

  useEffect(() => {
    const names = ([] as DialogKey[]).concat((browserRouter.query.dialog as any) ?? []);
    prevState.current = {
      url: history.state.url,
      as: history.state.as,
      pathname: history.state.url.split('?')[0],
    };
    const openDialogs = useDialogStore
      .getState()
      .dialogs.filter((x) => x.type === 'routed-dialog')
      .map((x) => x.id as DialogKey);
    const toClose = openDialogs.filter((id) => !names.includes(id));
    const toOpen = names.filter((name) => !openDialogs.includes(name));

    for (const name of toOpen) {
      const sessionState = sessionStorage.getItem(name as DialogKey);
      const state = sessionState ? JSON.parse(sessionState) : undefined;
      const Dialog = createBrowserRouterSync(dialogs[name].component);
      dialogStore.trigger({
        id: name,
        component: Dialog,
        props: { ...state },
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

export function triggerRoutedDialog<T extends DialogKey>({
  name,
  state,
}: {
  name: T;
  state: ComponentProps<(typeof dialogs)[T]['component']>;
}) {
  const browserRouter = getBrowserRouter();
  const { url, asPath, state: sessionState } = resolveDialog(name, browserRouter.query, state);

  if (sessionState) {
    sessionStorage.setItem(
      name,
      JSON.stringify(sessionState, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    );
  }

  browserRouter.push(url, asPath);
}

export function RoutedDialogLink<T extends DialogKey, TPassHref extends boolean = false>({
  name,
  state,
  children,
  className,
  passHref,
}: {
  name: T;
  state: ComponentProps<(typeof dialogs)[T]['component']>;
  passHref?: TPassHref;
  className?: string;
  children: TPassHref extends true ? React.ReactElement : React.ReactNode;
}) {
  const browserRouter = useBrowserRouter();
  const { url, asPath, state: sessionState } = resolveDialog(name, browserRouter.query, state);

  const handleClick = (e: any) => {
    e.preventDefault();
    if (sessionState)
      sessionStorage.setItem(
        name,
        JSON.stringify(sessionState, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )
      );

    browserRouter.push(url, asPath);
  };

  if (passHref) {
    return cloneElement(children as React.ReactElement, { href: asPath, onClick: handleClick });
  }

  return (
    <a href={asPath} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}

function createBrowserRouterSync<T extends Record<string, unknown>>(Dialog: ComponentType<T>) {
  return function BrowserRouterSync(args: ComponentProps<ComponentType<T>>) {
    const { query } = useBrowserRouter();
    return <Dialog {...args} {...query} />;
  };
}

function resolveDialog<T extends DialogKey>(
  name: T,
  query: Record<string, any>,
  state: ComponentProps<(typeof dialogs)[T]['component']>
) {
  const dialog = dialogs[name];
  if (!dialog) throw new Error('invalid dialog name');
  const {
    url,
    asPath,
    state: _state,
  } = dialog.resolve(
    {
      ...query,
      dialog: ([] as DialogKey[]).concat(query.dialog ?? []).concat(name),
    },
    { ...state, as: typeof history !== 'undefined' ? history.state.as : undefined }
  ); // eslint-disable-line

  const [_url, _urlAs] = resolveHref(Router, url, true);
  const [, _asPath] = asPath ? resolveHref(Router, asPath, true) : [_url, _urlAs];

  return { url: _url, asPath: _asPath, state: _state };
}
