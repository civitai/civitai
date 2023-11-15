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

type Url = UrlObject | string;
type DialogItem<T> = {
  requireAuth?: boolean;
  component: ComponentType<T>;
  resolve: (
    query: Record<string, unknown>,
    args: ComponentProps<ComponentType<T>>
  ) => { url: Url; asPath?: Url; state?: Record<string, unknown> };
};
type DialogRegistry<T extends Record<string, unknown>> = { [K in keyof T]: DialogItem<T[K]> };

function createDialogDictionary<T extends Record<string, unknown>>(
  dictionary: DialogRegistry<T>
): DialogRegistry<T> {
  return dictionary;
}

export const dialogs = createDialogDictionary({
  imageDetail: {
    component: ImageDetailModal,
    resolve: (query, { imageId, ...state }) => ({
      url: { query: { ...query, imageId } },
      asPath: `/images/${imageId}`,
      state,
    }),
  },
  postDetail: {
    component: PostDetailModal,
    resolve: (query, { postId }) => ({
      url: { query: { ...query, postId } },
      asPath: `/posts/${postId}`,
    }),
  },
  collectionEdit: {
    component: CollectionEditModal,
    resolve: (query, { collectionId }) => ({
      url: { query: { ...query, collectionId } },
    }),
  },
  hiddenModelComments: {
    component: HiddenCommentsModal,
    resolve: (query, { modelId }) => ({
      url: { query: { ...query, modelId } },
    }),
  },
  resourceReview: {
    component: ResourceReviewModal,
    resolve: (query, { reviewId }) => ({
      url: { query: { ...query, reviewId } },
    }),
  },
  filesEdit: {
    component: FilesEditModal,
    resolve: (query, { modelVersionId }) => ({
      url: { query: { ...query, modelVersionId } },
    }),
  },
});
