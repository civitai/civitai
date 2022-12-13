import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React, { createContext, useContext } from 'react';
import { QS } from '~/utils/qs';

const ModelVersionLightbox = dynamic(() => import('~/routed-context/modals/ModelVersionLightbox'));
const ReviewLightbox = dynamic(() => import('~/routed-context/modals/ReviewLightbox'));

const dictionary = {
  modelVersionLightbox: ModelVersionLightbox,
  reviewLightbox: ReviewLightbox,
};

// function register<T extends Record<string, ComponentType>>(dictionary: T) {
//   return dictionary;
// }

type RoutedContext = {
  openContext: <TName extends keyof typeof dictionary>(
    name: TName,
    props: React.ComponentProps<typeof dictionary[TName]>
  ) => void;
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

  function openContext<TName extends keyof typeof dictionary>(
    name: TName,
    props: React.ComponentProps<typeof dictionary[TName]>
  ) {
    const [pathname, query] = router.asPath.split('?');
    const ctxProps = { ...QS.parse(query), modal: name, ...props };
    router.push(
      { pathname, query: { ...router.query, ...ctxProps } },
      { pathname, query: { ...ctxProps } },
      {
        shallow: true,
      }
    );
  }

  function renderModal() {
    if (!modal || Array.isArray(modal)) return null;
    const Modal = dictionary[modal as keyof typeof dictionary];
    const [, query] = router.asPath.split('?');
    return Modal ? <Modal {...(QS.parse(query) as any)} /> : null;
  }

  return (
    <RoutedCtx.Provider value={{ openContext }}>
      {children}
      {renderModal()}
    </RoutedCtx.Provider>
  );
}
