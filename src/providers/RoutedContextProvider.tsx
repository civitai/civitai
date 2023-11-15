import React, { ComponentType, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Router, { NextRouter, useRouter } from 'next/router';
import { QS } from '~/utils/qs';
import { getHasClientHistory } from '~/store/ClientHistoryStore';
import { create } from 'zustand';
import { NextLink } from '@mantine/next';
import { removeEmpty } from '~/utils/object-helpers';
import useIsClient from '~/hooks/useIsClient';
import { Freeze } from '~/components/Freeze/Freeze';

const CommentThread = dynamic(() => import('~/routed-context/modals/CommentThread'));
const CommentEdit = dynamic(() => import('~/routed-context/modals/CommentEdit'));
const FilesEdit = dynamic(() => import('~/routed-context/modals/FilesEdit'));

const registry = {
  filesEdit: {
    Component: FilesEdit,
    resolve: (args: React.ComponentProps<typeof FilesEdit>) => [
      { query: { ...Router.query, ...args, modal: 'filesEdit' } },
      undefined, // could be a page url for reviews here (/reviews/:reviewId)
      { shallow: true },
    ],
  },
  commentThread: {
    Component: CommentThread,
    resolve: (args: React.ComponentProps<typeof CommentThread>) => [
      { query: { ...Router.query, ...args, modal: 'commentThread' } },
      undefined, // could be a page url for reviews here (/comments/:commentId)
      { shallow: true },
    ],
  },
  commentEdit: {
    Component: CommentEdit,
    resolve: (args: React.ComponentProps<typeof CommentEdit>) => [
      { query: { ...Router.query, ...args, modal: 'commentEdit' } },
      undefined, // could be a page url for reviews here (/comments/:commentId)
      { shallow: true },
    ],
  },
};

export async function openRoutedContext<TName extends keyof typeof registry>(
  modal: TName,
  props: React.ComponentProps<(typeof registry)[TName]['Component']>,
  optionsOverride?: { replace?: boolean }
) {
  useFreezeStore.getState().setFreeze(true);
  const resolve = registry[modal].resolve;
  const [url, as, options] = resolve(props as any) as Parameters<NextRouter['push']>;
  await Router.push(url, as, { ...options, ...optionsOverride });
}

export function closeRoutedContext() {
  const hasHistory = getHasClientHistory();
  const { modal, ...query } = Router.query;
  if (modal) {
    if (hasHistory) Router.back();
    else {
      const [pathname] = Router.asPath.split('?');
      Router.push({ pathname, query }, { pathname }, { shallow: true });
    }
  }
}

export function RoutedContextProvider2() {
  const router = useRouter();
  const modal = router.query.modal;
  const setFreeze = useFreezeStore((state) => state.setFreeze);

  useEffect(() => {
    if (!modal) setFreeze(false);
  }, [modal]) //eslint-disable-line

  if (!modal) return null;

  const query = QS.parse(QS.stringify(router.query));
  delete query.ref;
  const Modal = registry[modal as keyof typeof registry]?.Component;
  // TODO.logging - log when modal is specified by we didn't get a Modal
  return Modal ? <Modal {...(query as any)} /> : null;
}

type OpenRoutedContextProps<TName extends keyof typeof registry> = {
  modal: TName;
  options?: { replace?: boolean };
  children: React.ReactElement;
} & React.ComponentProps<(typeof registry)[TName]['Component']>;

// TODO.posts - replace instances of AnchorNoTravel with this
export function RoutedContextLink<TName extends keyof typeof registry>({
  modal,
  options: initialOptions,
  children,
  onClick,
  style,
  className,
  ...props
}: OpenRoutedContextProps<TName> & {
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  const setFreeze = useFreezeStore((state) => state.setFreeze);
  const toResolve = removeEmpty(props);
  const isClient = useIsClient();
  const handleClick = () => openRoutedContext(modal, toResolve as any, initialOptions);

  if (!isClient) return React.cloneElement(children, { onClick: handleClick });

  const resolve = registry[modal].resolve;
  const [url, as, options] = resolve(toResolve as any) as Parameters<NextRouter['push']>;
  return (
    <NextLink
      href={url}
      as={as}
      {...options}
      onClick={(e) => {
        if (!e.ctrlKey) {
          onClick?.(e);
          setFreeze(true);
        }
      }}
      style={style}
      className={className}
      rel="nofollow noindex"
    >
      {children}
    </NextLink>
  );
}

export const useFreezeStore = create<{
  freeze: boolean;
  placeholder?: React.ReactNode;
  setFreeze: (freeze: boolean) => void;
}>((set, get) => ({
  freeze: false,
  placeholder: undefined,
  setFreeze: (freeze: boolean) =>
    set((state) => {
      if (state.freeze === freeze) return {};
      // let placeholder: React.ReactNode | undefined;
      // if (freeze) {
      //   const placeholderContent = document.getElementById('freezeBlock')?.innerHTML;
      //   placeholder = placeholderContent ? (
      //     <div dangerouslySetInnerHTML={{ __html: placeholderContent }} />
      //   ) : undefined;
      // }

      return { freeze };
    }),
}));

export function FreezeProvider({ children }: { children: React.ReactElement }) {
  const freeze = useFreezeStore((state) => state.freeze);
  // const placeholder = useFreezeStore((state) => state.placeholder);

  return (
    <Freeze freeze={freeze}>
      <div id="freezeBlock">{children}</div>
    </Freeze>
  );
}
