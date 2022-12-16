import { usePrevious } from '@mantine/hooks';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React, { createContext, useContext, useEffect } from 'react';
import { QS } from '~/utils/qs';

const ModelVersionLightbox = dynamic(() => import('~/routed-context/modals/ModelVersionLightbox'));
const ReviewLightbox = dynamic(() => import('~/routed-context/modals/ReviewLightbox'));
const ReviewEdit = dynamic(() => import('~/routed-context/modals/ReviewEdit'));
const RunStrategy = dynamic(() => import('~/routed-context/modals/RunStrategy'));
const ReviewThread = dynamic(() => import('~/routed-context/modals/ReviewThread'));
const CommentThread = dynamic(() => import('~/routed-context/modals/CommentThread'));
const CommentEdit = dynamic(() => import('~/routed-context/modals/CommentEdit'));
const Report = dynamic(() => import('~/routed-context/modals/Report'));

const dictionary = {
  modelVersionLightbox: ModelVersionLightbox,
  reviewLightbox: ReviewLightbox,
  reviewEdit: ReviewEdit,
  runStrategy: RunStrategy,
  reviewThread: ReviewThread,
  commentThread: CommentThread,
  commentEdit: CommentEdit,
  report: Report,
};

// function register<T extends Record<string, ComponentType>>(dictionary: T) {
//   return dictionary;
// }

type RoutedContext = {
  openContext: <TName extends keyof typeof dictionary>(
    name: TName,
    props: React.ComponentProps<typeof dictionary[TName]>
  ) => void;
  closeContext: () => void;
};

const RoutedCtx = createContext<RoutedContext>({} as any);

export const useRoutedContext = () => {
  const context = useContext(RoutedCtx);
  if (!context) throw new Error('useRoutedContext can only be used inside RoutedContextProvider');

  return context;
};

export function RoutedContextProvider({ children }: { children: React.ReactElement }) {
  const router = useRouter();
  const { modal } = router.query;
  const previous = usePrevious(router.asPath.split('?')[0]);

  useEffect(() => {
    /*
    The current value of prevPath doesn't matter. What matters is that prevPath won't have a session value on the first page a user lands on. If a user has a modal link that they copy and paste into the url, prevPath won't have a value, and the modal close button will behave differently
    */
    if (previous) sessionStorage.setItem('prevPath', previous);
  }, [previous]);

  function openContext<TName extends keyof typeof dictionary>(
    name: TName,
    props: React.ComponentProps<typeof dictionary[TName]>
  ) {
    const [pathname, query] = router.asPath.split('?');
    //TODO - when a value is present in the url params, don't let it be added to the query string
    const ctxProps = { ...QS.parse(query), modal: name, ...props };

    router.push(
      { pathname, query: { ...router.query, ...ctxProps } },
      { pathname, query: { ...ctxProps } },
      {
        shallow: true,
      }
    );
  }

  function closeContext() {
    // extract the props you don't want to forward
    const { modal, ...query } = router.query;
    const prev = sessionStorage.getItem('prevPath');
    // console.log(!prev ? 'push' : 'back', { prev });
    !prev
      ? router.push(
          { pathname: router.asPath.split('?')[0], query },
          { pathname: router.asPath.split('?')[0] },
          { shallow: true }
        )
      : router.back();
  }

  function renderModal() {
    if (!modal || Array.isArray(modal)) return null;
    const Modal = dictionary[modal as keyof typeof dictionary];
    const [, query] = router.asPath.split('?');
    return Modal ? <Modal {...(QS.parse(query) as any)} /> : null;
  }

  return (
    <RoutedCtx.Provider value={{ openContext, closeContext }}>
      {children}
      {renderModal()}
    </RoutedCtx.Provider>
  );
}
