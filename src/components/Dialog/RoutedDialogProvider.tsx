import type { ComponentProps, ComponentType } from 'react';
import React, { useEffect, useRef } from 'react';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import Router, { useRouter } from 'next/router';
import type { DialogKey } from './routed-dialog/registry';
import { dialogs } from './routed-dialog/registry';
import {
  setUsingNextRouter,
  getBrowserRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getHasClientHistory } from '~/store/ClientHistoryStore';

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
      const dialog = dialogs[name];
      if (!dialog) continue;
      if ((dialog as any).requireAuth && !currentUser) continue;
      const state = history.state.state;
      const Dialog = createBrowserRouterSync(dialog.component);
      dialogStore.trigger({
        id: key,
        component: Dialog,
        props: { ...browserRouter.query, ...state },
        options: { onClose: () => handleCloseRoutedDialog(name) },
        type: 'routed-dialog',
        target: (dialog as any).target,
      });
    }

    for (const key of toClose) {
      dialogStore.closeById(key);
    }
  }, [browserRouter.query, currentUser]);

  return null;
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

function createBrowserRouterSync(Dialog: ComponentType<any>) {
  return function BrowserRouterSync(args: ComponentProps<ComponentType<any>>) {
    const { query, state } = useBrowserRouter();
    return <Dialog {...args} {...query} {...state} />;
  };
}
