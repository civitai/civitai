import type { ComponentProps } from 'react';
import React, { cloneElement } from 'react';
import Router, { useRouter } from 'next/router';
import type { DialogKey } from './routed-dialog/registry';
import { dialogs } from './routed-dialog/registry';
import { getBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import type { NextRouter } from 'next/dist/shared/lib/router/router';
import { resolveHref } from 'next/dist/client/resolve-href';
import { QS } from '~/utils/qs';
import type { AnchorProps } from '@mantine/core';
import { Anchor } from '@mantine/core';

export function triggerRoutedDialog<T extends DialogKey>({
  name,
  state,
}: {
  name: T;
  state: ComponentProps<(typeof dialogs)[T]['component']>;
}) {
  const browserRouter = getBrowserRouter();
  const query = browserRouter.query ?? {};

  // Skip if the dialog is already open with the same params
  const currentDialogs = ([] as DialogKey[]).concat(query.dialog ?? []);
  if (currentDialogs.includes(name)) {
    const dialog = dialogs[name];
    const result = dialog.resolve(query, state) as { query: Record<string, unknown> };
    if (QS.stringify(result.query) === QS.stringify(query)) return;
  }

  const { url, asPath, state: sessionState } = resolveDialog(name, query, state);
  browserRouter.push(url, asPath, sessionState);
}

export function RoutedDialogLink<T extends DialogKey, TPassHref extends boolean = false>({
  name,
  state,
  children,
  className,
  passHref,
  style,
  onClick,
  variant = 'text',
}: {
  name: T;
  state: ComponentProps<(typeof dialogs)[T]['component']>;
  passHref?: TPassHref;
  className?: string;
  children: TPassHref extends true ? React.ReactElement : React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
  variant?: AnchorProps['variant'];
}) {
  const router = useRouter();
  const { query = QS.parse(QS.stringify(router.query)) } = getBrowserRouter();
  const { asPath } = resolveDialog(name, query, state, router);

  const handleClick = (e: any) => {
    if (!e.ctrlKey) {
      e.preventDefault();
      // e.stopPropagation();
      triggerRoutedDialog({ name, state });
      onClick?.();
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
    <Anchor
      href={asPath}
      onClick={handleClick}
      className={className}
      style={style}
      variant={variant}
    >
      {children}
    </Anchor>
  );
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

  const result = dialog.resolve(
    {
      ...query,
      dialog: ([] as DialogKey[]).concat(query.dialog ?? []).concat(name),
    },
    state
  ) as { query: Record<string, unknown>; asPath?: any; state?: any }; // eslint-disable-line

  const resolvedQuery = result.query;
  const asPath = result.asPath ?? getAsPath(resolvedQuery, router);
  const _state = result.state;

  const [_url, _urlAs] = resolveHref(router, { query: resolvedQuery as any }, true);
  const [, _asPath] = asPath ? resolveHref(router, asPath, true) : [_url, _urlAs];
  // console.log({ _url, _urlAs, _asPath });

  return { url: _url, asPath: _asPath, state: _state };
}
