import dynamic from 'next/dynamic';
import type { ComponentProps, ComponentType } from 'react';
import type { UrlObject } from 'url';

// import {
//   ImageDetailModal,
//   CollectionEditModal,
//   HiddenCommentsModal,
//   ResourceReviewModal,
//   FilesEditModal,
//   CommentEditModal,
//   CommentThreadModal,
//   SupportModal,
// } from './dialog-registry';

export const ImageDetailModal = dynamic(
  () => import('~/components/Image/Detail/ImageDetailModal'),
  {
    ssr: false,
  }
);
export const CollectionEditModal = dynamic(
  () => import('~/components/Collections/CollectionEditModal'),
  {
    ssr: false,
  }
);
export const HiddenCommentsModal = dynamic(
  () => import('~/components/CommentsV2/HiddenCommentsModal'),
  {
    ssr: false,
  }
);
export const ResourceReviewModal = dynamic(
  () => import('~/components/ResourceReview/ResourceReviewModal'),
  { ssr: false }
);
export const FilesEditModal = dynamic(() => import('~/components/Resource/FilesEditModal'), {
  ssr: false,
});
export const CommentEditModal = dynamic(
  () => import('~/components/Model/ModelDiscussion/CommentEditModal'),
  { ssr: false }
);
export const CommentThreadModal = dynamic(
  () => import('~/components/Model/Discussion/CommentThreadModal'),
  { ssr: false }
);
export const SupportModal = dynamic(() => import('~/components/Support/SupportModal'), {
  ssr: false,
});
export const GeneratedImageLightbox = dynamic(
  () => import('~/components/ImageGeneration/GeneratedImageLightbox'),
  { ssr: false }
);

type Url = UrlObject | string;
type DialogItem<T> = {
  requireAuth?: boolean;
  component: ComponentType<T>;
  target?: string;
  resolve: (
    query: Record<string, unknown>,
    args: ComponentProps<ComponentType<T>>
  ) => { query: Record<string, unknown>; asPath?: Url; state?: Record<string, unknown> };
};
type DialogRegistry<T extends Record<string, any>> = { [K in keyof T]: DialogItem<T[K]> };

function createDialogDictionary<T extends Record<string, unknown>>(
  dictionary: DialogRegistry<T>
): DialogRegistry<T> {
  return dictionary;
}

export type DialogKey = keyof typeof dialogs;
export type DialogState<T extends DialogKey> = ComponentProps<(typeof dialogs)[T]['component']>;
export const dialogs = createDialogDictionary({
  imageDetail: {
    component: ImageDetailModal,
    target: '#main',
    resolve: (query, { imageId, ...state }) => ({
      query: { ...query, imageId },
      asPath: `/images/${imageId}`,
      state,
    }),
  },
  collectionEdit: {
    component: CollectionEditModal,
    resolve: (query, { collectionId }) => ({
      query: { ...query, collectionId },
    }),
  },
  hiddenComments: {
    component: HiddenCommentsModal,
    resolve: (query, { entityType, entityId }) => ({
      query: { ...query, entityType, entityId },
    }),
  },
  resourceReview: {
    component: ResourceReviewModal,
    target: '#main',
    resolve: (query, { reviewId }) => ({
      query: { ...query, reviewId },
    }),
  },
  filesEdit: {
    component: FilesEditModal,
    resolve: (query, { modelVersionId }) => ({
      query: { ...query, modelVersionId },
    }),
  },
  commentEdit: {
    component: CommentEditModal,
    resolve: (query, { commentId }) => ({
      query: { ...query, commentId },
    }),
  },
  commentThread: {
    component: CommentThreadModal,
    resolve: (query, { commentId, highlight }) => ({
      query: { ...query, commentId, highlight },
    }),
  },
  support: {
    component: SupportModal,
    resolve: (query) => ({
      query,
      asPath: '/support',
    }),
  },
  generatedImage: {
    component: GeneratedImageLightbox,
    resolve: (query, { imageId, workflowId }) => ({
      query: { ...query, imageId, workflowId },
    }),
  },
});
