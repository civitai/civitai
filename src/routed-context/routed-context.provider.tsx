import { usePrevious } from '@mantine/hooks';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { QS } from '~/utils/qs';

const ModelVersionLightbox = dynamic(() => import('~/routed-context/modals/ModelVersionLightbox'));
const ReviewLightbox = dynamic(() => import('~/routed-context/modals/ReviewLightbox'));
const ReviewEdit = dynamic(() => import('~/routed-context/modals/ReviewEdit'));
const RunStrategy = dynamic(() => import('~/routed-context/modals/RunStrategy'));
const ReviewThread = dynamic(() => import('~/routed-context/modals/ReviewThread'));
const CommentThread = dynamic(() => import('~/routed-context/modals/CommentThread'));
const CommentEdit = dynamic(() => import('~/routed-context/modals/CommentEdit'));
const Report = dynamic(() => import('~/routed-context/modals/Report'));
const BlockModelTags = dynamic(() => import('~/routed-context/modals/BlockModelTags'));

const dictionary = {
  modelVersionLightbox: ModelVersionLightbox,
  reviewLightbox: ReviewLightbox,
  reviewEdit: ReviewEdit,
  runStrategy: RunStrategy,
  reviewThread: ReviewThread,
  commentThread: CommentThread,
  commentEdit: CommentEdit,
  report: Report,
  blockTags: BlockModelTags,
};

// function register<T extends Record<string, ComponentType>>(dictionary: T) {
//   return dictionary;
// }

type RoutedContext = {
  openContext: <TName extends keyof typeof dictionary>(
    name: TName,
    props: React.ComponentProps<typeof dictionary[TName]>,
    options?: { replace?: boolean }
  ) => void;
  closeContext: () => Promise<void>;
};

const RoutedCtx = createContext<RoutedContext>({} as any);  // eslint-disable-line

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

  const openContext: RoutedContext['openContext'] = (name, props, options) => {
    const { replace = false } = options || {};
    const [pathname, query] = router.asPath.split('?');
    //TODO - when a value is present in the url params, don't let it be added to the query string
    const ctxProps = { ...QS.parse(query), modal: name, ...props };
    const navigate = replace ? router.replace : router.push;

    navigate(
      { pathname, query: { ...router.query, ...ctxProps } },
      { pathname, query: { ...ctxProps } },
      { shallow: true }
    );
  };

  const [closing, setClosing] = useState(false);

  const closeContext: RoutedContext['closeContext'] = async () => {
    // extract the props you don't want to forward
    const { modal, ...query } = router.query;
    const prev = sessionStorage.getItem('prevPath');

    if (modal && !closing) {
      if (!prev)
        await router.push(
          { pathname: router.asPath.split('?')[0], query },
          { pathname: router.asPath.split('?')[0] },
          { shallow: true }
        );
      else router.back();
    }
  };

  function renderModal() {
    if (!modal || Array.isArray(modal)) return null;
    const Modal = dictionary[modal as keyof typeof dictionary];
    const [, query] = router.asPath.split('?');

    return Modal ? <Modal {...(QS.parse(query) as any)} /> : null; // eslint-disable-line
  }

  // Prevent triggering the closing event multiple times while still navigating
  useEffect(() => {
    function toggleClosing(toggle: boolean) {
      return () => setClosing(toggle);
    }
    router.events.on('routeChangeStart', toggleClosing(true));
    router.events.on('routeChangeComplete', toggleClosing(false));

    return () => {
      router.events.off('routeChangeStart', toggleClosing(true));
      router.events.off('routeChangeComplete', toggleClosing(false));
    };
  }, [router.events]);

  return (
    <RoutedCtx.Provider value={{ openContext, closeContext }}>
      {children}
      {renderModal()}
    </RoutedCtx.Provider>
  );
}
