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
import { useCurrentUser } from '~/hooks/useCurrentUser';

type DialogKey = keyof typeof dialogs;

export function RoutedDialogProvider() {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const prevState = useRef<{ url: string; as: string; pathname: string }>();
  const currentUser = useCurrentUser();

  useEffect(() => {
    router.beforePopState((state) => {
      const previous = prevState.current;
      setUsingNextRouter(true);

      // it's magic...
      if (!state.url.includes('dialog') && router.pathname !== state.url.split('?')[0]) {
        return true;
      }
      if (state.url.includes('dialog') || previous?.url.includes('dialog')) {
        setUsingNextRouter(false);
        return false;
      }
      return true;
    });
  }, [router]);

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
    prevState.current = {
      url: history.state.url,
      as: history.state.as,
      pathname: history.state.url.split('?')[0],
    };
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
        options: { onClose: () => history.go(-1) },
        type: 'routed-dialog',
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
  const browserRouter = getBrowserRouter();
  const { asPath } = resolveDialog(name, browserRouter.query, state);

  const handleClick = (e: any) => {
    e.preventDefault();
    triggerRoutedDialog({ name, state });
  };

  if (passHref) {
    return cloneElement(children as React.ReactElement, {
      href: asPath,
      onClick: handleClick,
      className,
      style,
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
    state
  ); // eslint-disable-line

  const [_url, _urlAs] = resolveHref(Router, url, true);
  const [, _asPath] = asPath ? resolveHref(Router, asPath, true) : [_url, _urlAs];

  return { url: _url, asPath: _asPath, state: _state };
}
