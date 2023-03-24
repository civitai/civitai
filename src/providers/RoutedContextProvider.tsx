import React, { ComponentType, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Router, { NextRouter, useRouter } from 'next/router';
import { QS } from '~/utils/qs';
import { getHasClientHistory } from '~/store/ClientHistoryStore';
import { create } from 'zustand';
import { Freeze } from 'react-freeze';
import { NextLink } from '@mantine/next';
import { removeEmpty } from '~/utils/object-helpers';
import useIsClient from '~/hooks/useIsClient';

const ModelVersionLightbox = dynamic(() => import('~/routed-context/modals/ModelVersionLightbox'));
const ReviewLightbox = dynamic(() => import('~/routed-context/modals/ReviewLightbox'));
const ReviewEdit = dynamic(() => import('~/routed-context/modals/ReviewEdit'));
const ReviewThread = dynamic(() => import('~/routed-context/modals/ReviewThread'));
const CommentThread = dynamic(() => import('~/routed-context/modals/CommentThread'));
const GalleryDetailModal = dynamic(() => import('~/routed-context/modals/GalleryDetailModal'));
const ImageDetailModal = dynamic(() => import('~/routed-context/modals/ImageDetailModal'));
const CommentEdit = dynamic(() => import('~/routed-context/modals/CommentEdit'));
const ModelEdit = dynamic(() => import('~/routed-context/modals/ModelEdit'));
const ModelVersionEdit = dynamic(() => import('~/routed-context/modals/ModelVersionEdit'));
const FilesEdit = dynamic(() => import('~/routed-context/modals/FilesEdit'));

// this is they type I want to hook up at some point
type ModalRegistry<P> = {
  Component: ComponentType<P>;
  resolve: (args: P) => Parameters<NextRouter['push']>;
};

const registry = {
  modelEdit: {
    Component: ModelEdit,
    resolve: (args: React.ComponentProps<typeof ModelEdit>) => [
      { query: { ...Router.query, ...args, modal: 'modelEdit' } },
      undefined, // could be a page url for reviews here (/reviews/:reviewId)
      { shallow: true },
    ],
  },
  modelVersionEdit: {
    Component: ModelVersionEdit,
    resolve: (args: React.ComponentProps<typeof ModelVersionEdit>) => [
      { query: { ...Router.query, ...args, modal: 'modelVersionEdit' } },
      undefined, // could be a page url for reviews here (/reviews/:reviewId)
      { shallow: true },
    ],
  },
  filesEdit: {
    Component: FilesEdit,
    resolve: (args: React.ComponentProps<typeof FilesEdit>) => [
      { query: { ...Router.query, ...args, modal: 'filesEdit' } },
      undefined, // could be a page url for reviews here (/reviews/:reviewId)
      { shallow: true },
    ],
  },
  reviewThread: {
    Component: ReviewThread,
    resolve: (args: React.ComponentProps<typeof ReviewThread>) => [
      { query: { ...Router.query, ...args, modal: 'reviewThread' } },
      undefined, // could be a page url for reviews here (/reviews/:reviewId)
      { shallow: true },
    ],
  },
  reviewEdit: {
    Component: ReviewEdit,
    resolve: (args: React.ComponentProps<typeof ReviewEdit>) => [
      { query: { ...Router.query, ...args, modal: 'reviewEdit' } },
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
  reviewLightbox: {
    Component: ReviewLightbox,
    resolve: (args: React.ComponentProps<typeof ReviewLightbox>) => [
      { query: { ...Router.query, ...args, modal: 'reviewLightbox' } },
      undefined, // could be a page url for reviews here (/comments/:commentId)
      { shallow: true },
    ],
  },
  modelVersionLightbox: {
    Component: ModelVersionLightbox,
    resolve: (args: React.ComponentProps<typeof ModelVersionLightbox>) => [
      { query: { ...Router.query, ...args, modal: 'modelVersionLightbox' } },
      undefined, // could be a page url for reviews here (/comments/:commentId)
      { shallow: true },
    ],
  },
  galleryDetailModal: {
    Component: GalleryDetailModal,
    resolve: ({ galleryImageId, ...args }: React.ComponentProps<typeof GalleryDetailModal>) => {
      const slug = Router.query.slug ?? 'placeholder';
      return [
        {
          query: { ...Router.query, slug, galleryImageId, ...args, modal: 'galleryDetailModal' },
        },
        {
          pathname: `/gallery/${galleryImageId}`,
          query: args,
        }, // could be a page url for reviews here (/comments/:commentId)
        { shallow: true },
      ];
    },
  },
  imageDetailModal: {
    Component: ImageDetailModal,
    resolve: ({ imageId, ...args }: React.ComponentProps<typeof ImageDetailModal>) => {
      const slug = Router.query.slug ?? 'placeholder';
      return [
        {
          query: { ...Router.query, slug, imageId, ...args, modal: 'imageDetailModal' },
        },
        {
          pathname: `/images/${imageId}`,
          query: args,
        },
        { shallow: true },
      ];
    },
  },
};

export function openRoutedContext<TName extends keyof typeof registry>(
  modal: TName,
  props: React.ComponentProps<(typeof registry)[TName]['Component']>,
  optionsOverride?: { replace?: boolean }
) {
  useFreezeStore.getState().setFreeze(true);
  const resolve = registry[modal].resolve;
  const [url, as, options] = resolve(props as any) as Parameters<NextRouter['push']>;
  Router.push(url, as, { ...options, ...optionsOverride });
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
  const Modal = registry[query.modal as keyof typeof registry].Component;
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
  ...props
}: OpenRoutedContextProps<TName> & { onClick?: () => void }) {
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
        e.stopPropagation();
        if (!e.ctrlKey) {
          onClick?.();
          setFreeze(true);
        }
      }}
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
      let placeholder: React.ReactNode | undefined;
      if (freeze) {
        const placeholderContent = document.getElementById('freezeBlock')?.innerHTML;
        placeholder = placeholderContent ? (
          <div dangerouslySetInnerHTML={{ __html: placeholderContent }} />
        ) : undefined;
      }

      return { freeze, placeholder };
    }),
}));

export function FreezeProvider({ children }: { children: React.ReactElement }) {
  const freeze = useFreezeStore((state) => state.freeze);
  const placeholder = useFreezeStore((state) => state.placeholder);
  return (
    <Freeze freeze={freeze} placeholder={placeholder}>
      <div id="freezeBlock">{children}</div>
    </Freeze>
  );
}
