import React, { ComponentType, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Router, { NextRouter, useRouter } from 'next/router';
import Link from 'next/link';
import { QS } from '~/utils/qs';
import { getHasClientHistory } from '~/store/ClientHistoryStore';
import { useDidUpdate, useWindowEvent } from '@mantine/hooks';

const ModelVersionLightbox = dynamic(() => import('~/routed-context/modals/ModelVersionLightbox'));
const ReviewLightbox = dynamic(() => import('~/routed-context/modals/ReviewLightbox'));
const ReviewEdit = dynamic(() => import('~/routed-context/modals/ReviewEdit'));
const ReviewThread = dynamic(() => import('~/routed-context/modals/ReviewThread'));
const CommentThread = dynamic(() => import('~/routed-context/modals/CommentThread'));
const GalleryDetailModal = dynamic(() => import('~/routed-context/modals/GalleryDetailModal'));
const CommentEdit = dynamic(() => import('~/routed-context/modals/CommentEdit'));
const ModelEdit = dynamic(() => import('~/routed-context/modals/ModelEdit'));

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
};

export function openRoutedContext<TName extends keyof typeof registry>(
  modal: TName,
  props: React.ComponentProps<typeof registry[TName]['Component']>,
  optionsOverride?: { replace?: boolean }
) {
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

  if (!modal) return null;

  const query = QS.parse(QS.stringify(router.query));
  const Modal = registry[query.modal as keyof typeof registry].Component;
  return Modal ? <Modal {...(query as any)} /> : null;
}

type OpenRoutedContextProps<TName extends keyof typeof registry> = {
  modal: TName;
  options?: { replace?: boolean };
  children: React.ReactElement;
} & React.ComponentProps<typeof registry[TName]['Component']>;

export function RoutedContextLink<TName extends keyof typeof registry>({
  modal,
  options: optionsOverride,
  children,
  ...props
}: OpenRoutedContextProps<TName>) {
  const resolve = registry[modal].resolve;
  const [url, as, options] = resolve(props as any) as Parameters<NextRouter['push']>;

  return (
    <Link href={url} as={as} {...options}>
      {children}
    </Link>
  );
}
