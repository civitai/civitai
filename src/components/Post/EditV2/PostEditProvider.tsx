import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { PostEditQuerySchema } from '~/server/schema/post.schema';
import { PostDetailEditable } from '~/server/services/post.service';
import { createStore } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useDidUpdate } from '@mantine/hooks';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import { trpc } from '~/utils/trpc';
import Router from 'next/router';
import { FileUploadProvider } from '~/components/FileUpload/FileUploadProvider';

const replacerFunc = () => {
  const visited = new WeakSet();
  return (key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (visited.has(value)) {
        return;
      }
      visited.add(value);
    }
    return value;
  };
};

// #region [types]
type ExtendedParams = {
  postTitle?: string;
  confirmTitle?: React.ReactNode;
  confirmPublish?: boolean;
  confirmMessage?: string;
  afterPublish?: (data: { postId: number; publishedAt: Date }) => void | Promise<void>;
};
type Params = PostEditQuerySchema & ExtendedParams;
type Props = {
  post?: PostDetailEditable;
  params?: PostEditQuerySchema;
  children: React.ReactNode;
} & ExtendedParams;

export type PostEditImageDetail = PostDetailEditable['images'][number] & { index: number };
export type PostEditMediaDetail = Omit<MediaUploadOnCompleteProps, 'status'>;
export type ControlledImage =
  | {
      type: 'added';
      data: PostEditImageDetail;
    }
  | {
      type: 'blocked';
      data: PostEditMediaDetail;
    };

type PostParams = Omit<PostDetailEditable, 'images'>;
type State = {
  post?: PostDetailEditable;
  images: ControlledImage[];
  isReordering: boolean;
  setPost: (data: PostParams) => void;
  updatePost: (cb: (data: PostParams) => void) => void;
  setImages: (cb: (images: ControlledImage[]) => ControlledImage[]) => void;
  updateImage: (id: number, cb: (image: PostEditImageDetail) => void) => void;
  toggleReordering: () => void;
};
// #endregion

// #region [create store]
type Store = ReturnType<typeof createContextStore>;
const createContextStore = (post?: PostDetailEditable) =>
  createStore<State>()(
    devtools(
      immer((set) => ({
        post,
        images:
          post?.images.map((data, index) => ({
            type: 'added',
            data: { ...data, index },
          })) ?? [],
        isReordering: false,
        setPost: (post) => set({ post: { ...post, images: [] } }),
        updatePost: (cb) =>
          set(({ post }) => {
            if (!post) return;
            cb(post);
          }),
        setImages: (cb) =>
          set((state) => {
            state.images = cb(state.images);
          }),
        updateImage: (id, cb) =>
          set((state) => {
            const index = state.images.findIndex((x) => x.type === 'added' && x.data.id === id);
            if (index > -1) cb(state.images[index].data as PostEditImageDetail);
          }),
        toggleReordering: () =>
          set((state) => {
            state.isReordering = !state.isReordering;
          }),
      })),
      { name: 'PostDetailEditable' }
    )
  );
// #endregion

// #region [state context]
const StoreContext = createContext<Store | null>(null);
export function usePostEditStore<T>(selector: (state: State) => T) {
  const store = useContext(StoreContext);
  if (!store) throw new Error('missing PostEditProvider');
  return useStoreWithEqualityFn(store, selector, shallow);
}
// #endregion

// #region [params context]
const ParamsContext = createContext<Params | null>(null);
export function usePostEditParams() {
  const context = useContext(ParamsContext);
  if (!context) throw new Error('missing ParamsContext');
  return context;
}
// #endregion

// #region [provider]
export function PostEditProvider({ post, params = {}, children, ...extendedParams }: Props) {
  const queryUtils = trpc.useUtils();
  const [store] = useState(() => createContextStore(post));
  const stringDependencies = JSON.stringify({ ...params, ...extendedParams }, replacerFunc);

  const mergedParams = useMemo(() => {
    return {
      ...params,
      ...extendedParams,
      postId: post?.id ?? params.postId,
      modelVersionId: post?.modelVersionId ?? params.modelVersionId,
    };
  }, [post, stringDependencies]); //eslint-disable-line

  const { modelVersionId, modelId, postId } = mergedParams;

  useDidUpdate(() => {
    store.setState({
      post,
      images:
        post?.images?.map((data, index) => ({
          type: 'added',
          data: { ...data, index },
        })) ?? [],
    });
  }, [post]);

  useEffect(() => {
    if (postId) {
      const handleBrowsingAway = async () => {
        await queryUtils.post.get.invalidate({ id: postId });
        await queryUtils.post.getEdit.invalidate({ id: postId });
        await queryUtils.post.getInfinite.invalidate();
        await queryUtils.image.getInfinite.invalidate({ postId });
        if (modelVersionId) {
          await queryUtils.modelVersion.getById.invalidate({ id: modelVersionId });
          await queryUtils.image.getImagesAsPostsInfinite.invalidate();
        }
        if (modelId) await queryUtils.model.getById.invalidate({ id: modelId });
      };

      Router.events.on('routeChangeComplete', handleBrowsingAway);
      return () => {
        Router.events.off('routeChangeComplete', handleBrowsingAway);
      };
    }
  }, [modelVersionId, modelId, postId]); // eslint-disable-line

  return (
    <StoreContext.Provider value={store}>
      <ParamsContext.Provider value={mergedParams}>
        <FileUploadProvider>{children}</FileUploadProvider>
      </ParamsContext.Provider>
    </StoreContext.Provider>
  );
}

// #endregion
