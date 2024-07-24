import dynamic from 'next/dynamic';
import { ComponentProps, ComponentType } from 'react';
import { UrlObject } from 'url';

const ImageDetailModal = dynamic(() => import('~/components/Image/Detail/ImageDetailModal'));
const PostDetailModal = dynamic(() => import('~/components/Post/Detail/PostDetailModal'));
const CollectionEditModal = dynamic(() => import('~/components/Collections/CollectionEditModal'));
const HiddenCommentsModal = dynamic(() => import('~/components/CommentsV2/HiddenCommentsModal'));
const ResourceReviewModal = dynamic(
  () => import('~/components/ResourceReview/ResourceReviewModal')
);
const FilesEditModal = dynamic(() => import('~/components/Resource/FilesEditModal'));
const CommentEditModal = dynamic(
  () => import('~/components/Model/ModelDiscussion/CommentEditModal')
);
const CommentThreadModal = dynamic(
  () => import('~/components/Model/Discussion/CommentThreadModal')
);
const SupportModal = dynamic(() => import('~/components/Support/SupportModal'));

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
  postDetail: {
    component: PostDetailModal,
    target: '#main',
    resolve: (query, { postId }) => ({
      query: { ...query, postId },
      asPath: `/posts/${postId}`,
    }),
  },
  collectionEdit: {
    component: CollectionEditModal,
    resolve: (query, { collectionId }) => ({
      query: { ...query, collectionId },
    }),
  },
  hiddenModelComments: {
    component: HiddenCommentsModal,
    resolve: (query, { modelId }) => ({
      query: { ...query, modelId },
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
});
