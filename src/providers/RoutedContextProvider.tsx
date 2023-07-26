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

const ModelVersionLightbox = dynamic(() => import('~/routed-context/modals/ModelVersionLightbox'));
const CommentThread = dynamic(() => import('~/routed-context/modals/CommentThread'));
const ImageDetailModal = dynamic(() => import('~/routed-context/modals/ImageDetailModal'));
const CommentEdit = dynamic(() => import('~/routed-context/modals/CommentEdit'));
const ModelEdit = dynamic(() => import('~/routed-context/modals/ModelEdit'));
const ModelVersionEdit = dynamic(() => import('~/routed-context/modals/ModelVersionEdit'));
const FilesEdit = dynamic(() => import('~/routed-context/modals/FilesEdit'));
const ResourceReviewModal = dynamic(() => import('~/routed-context/modals/ResourceReviewModal'));
const PostDetailModal = dynamic(() => import('~/routed-context/modals/PostDetailModal'));
const HiddenCommentsModal = dynamic(() => import('~/routed-context/modals/HiddenCommentsModal'));

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
  modelVersionLightbox: {
    Component: ModelVersionLightbox,
    resolve: (args: React.ComponentProps<typeof ModelVersionLightbox>) => [
      { query: { ...Router.query, ...args, modal: 'modelVersionLightbox' } },
      undefined, // could be a page url for reviews here (/comments/:commentId)
      { shallow: true },
    ],
  },
  imageDetailModal: {
    Component: ImageDetailModal,
    resolve: ({ imageId, ...args }: React.ComponentProps<typeof ImageDetailModal>) => {
      const slug = Router.query.slug ?? 'placeholder';
      const postSlug = Router.query.postSlug ?? 'placeholder';
      const { tags, ...prevRouterParams } = Router.query;
      return [
        {
          query: {
            ...prevRouterParams,
            slug,
            postSlug,
            imageId,
            ...args,
            modal: 'imageDetailModal',
          },
        },
        {
          pathname: `/images/${imageId}`,
          query: args,
        },
        { shallow: true },
      ];
    },
  },
  resourceReviewModal: {
    Component: ResourceReviewModal,
    resolve: ({ reviewId, ...args }: React.ComponentProps<typeof ResourceReviewModal>) => {
      const slug = Router.query.slug ?? 'placeholder';
      return [
        {
          query: { ...Router.query, slug, reviewId, ...args, modal: 'resourceReviewModal' },
        },
        {
          pathname: `/reviews/${reviewId}`,
          query: args,
        },
        { shallow: true },
      ];
    },
  },
  postDetailModal: {
    Component: PostDetailModal,
    resolve: ({ postId, postSlug, ...args }: React.ComponentProps<typeof PostDetailModal>) => {
      const slug = Router.query.slug ?? 'placeholder';
      let pathname = `/posts/${postId}`;
      if (postSlug) pathname += `/${postSlug}`;
      return [
        {
          query: { ...Router.query, slug, postId, ...args, modal: 'postDetailModal' },
        },
        {
          pathname,
          query: args,
        },
        { shallow: true },
      ];
    },
  },
  hiddenCommentsModal: {
    Component: HiddenCommentsModal,
    resolve: (args: React.ComponentProps<typeof HiddenCommentsModal>) => {
      return [
        { query: { ...Router.query, ...args, modal: 'hiddenCommentsModal' } },
        undefined,
        { shallow: true },
      ];
    },
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
  const Modal = registry[modal as keyof typeof registry].Component;
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
