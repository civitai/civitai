import { useDidUpdate, useLocalStorage } from '@mantine/hooks';
import { uniqBy } from 'lodash-es';
import Router from 'next/router';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import { FileUploadProvider } from '~/components/FileUpload/FileUploadProvider';
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import type { PostEditQuerySchema } from '~/server/schema/post.schema';
import type { PostDetailEditable, PostEditImageDetail } from '~/server/services/post.service';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

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

export type PostEditMediaDetail = MediaUploadOnCompleteProps;
export type ControlledImage =
  | {
      type: 'added';
      data: PostEditImageDetail;
    }
  | {
      type: 'blocked' | 'resolving' | 'error';
      data: PostEditMediaDetail;
    };

type PostParams = Omit<PostDetailEditable, 'images'>;
type State = {
  post?: PostDetailEditable;
  images: ControlledImage[];
  isReordering: boolean;
  collectionId?: number | null;
  collectionTagId: number | null;
  collectionItemExists?: boolean;
  setPost: (data: PostParams) => void;
  updatePost: (cb: (data: PostParams) => void) => void;
  setImages: (cb: (images: ControlledImage[]) => ControlledImage[]) => void;
  updateImage: (id: number, cb: (image: PostEditImageDetail) => void) => void;
  toggleReordering: () => void;
  /** Returns its own unregister, so callers can use it as an effect cleanup. */
  registerPendingSave: (key: string, flush: () => void) => () => void;
  flushPendingSaves: () => void;
  updateCollection: (
    collectionId: number | null,
    tagId?: number | null,
    collectionItemExists?: boolean
  ) => void;
};
// #endregion

// #region [create store]
type Store = ReturnType<typeof createContextStore>;
const createContextStore = (post?: PostDetailEditable) => {
  // Deliberately outside the store's reactive state: these are per-mount callbacks, not data.
  // Keeping them here means registering costs no `set()` (so no notification to every
  // subscriber, and nothing extra for the devtools middleware to serialize) and lets the many
  // tool/technique rows register at once — a single slot would silently drop all but the last.
  const pendingSaves = new Map<string, () => void>();

  return createStore<State>()(
    devtools(
      immer((set) => ({
        post,
        images:
          post?.images.map((data, index) => ({
            type: 'added',
            data: { ...data, index },
          })) ?? [],
        isReordering: false,
        collectionId: post?.collectionId,
        collectionTagId: post?.collectionTagId ?? null,
        collectionItemExists: post?.collectionItemExists,
        /**
         * @deprecated
         */
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
        registerPendingSave: (key, flush) => {
          pendingSaves.set(key, flush);
          return () => {
            if (pendingSaves.get(key) === flush) pendingSaves.delete(key);
          };
        },
        flushPendingSaves: () => {
          for (const flush of pendingSaves.values()) flush();
        },
        updateCollection: (collectionId, tagId, collectionItemExists) =>
          set({
            collectionId,
            collectionTagId: tagId,
            // Generally speaking we are sure it exists/will exist. However, if it's forcefully set as false, then we should respect that.
            collectionItemExists: collectionItemExists ?? true,
          }),
      })),
      {
        name: 'PostDetailEditable',
        // `import.meta.env` doesn't exist in a Next bundle, so zustand's own default resolves
        // to enabled everywhere — which serializes the whole store, images included, on every
        // `set()` for anyone with the Redux devtools extension installed.
        enabled: process.env.NODE_ENV !== 'production',
      }
    )
  );
};
// #endregion

// #region [state context]
const StoreContext = createContext<Store | null>(null);
export function usePostEditStore<T>(selector: (state: State) => T) {
  const store = useContext(StoreContext);
  if (!store) throw new Error('missing PostEditProvider');
  return useStore(store, selector, shallow);
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
    store.setState((state) => {
      const isSamePost = state.post && state.post.id === post?.id;
      const addedImages = state.images
        .map((x) => (x.type === 'added' ? x.data : undefined))
        .filter(isDefined);
      const postImages = post?.images ?? [];
      const images = isSamePost ? uniqBy([...postImages, ...addedImages], 'id') : postImages;

      return {
        post,
        images: images.map((data, index) => ({
          type: 'added',
          data: { ...data, index },
        })),
      };
    });
  }, [post]);

  useEffect(() => {
    const handleBrowsingAway = async () => {
      if (postId) {
        // console.log('browse away');
        await queryUtils.post.get.invalidate({ id: postId });
        // await queryUtils.post.getEdit.invalidate({ id: postId });
        await queryUtils.post.getEdit.setData({ id: postId }, (old) => {
          const { post, images } = store.getState();
          if (!post) return old;
          return {
            ...post,
            detail: post.detail ?? null,
            images: images.map((x) => (x.type === 'added' ? x.data : undefined)).filter(isDefined),
          };
        });
        await queryUtils.post.getInfinite.invalidate();
        await queryUtils.image.invalidate();
        if (modelVersionId) {
          await queryUtils.modelVersion.getById.invalidate({ id: modelVersionId });
          await queryUtils.image.getImagesAsPostsInfinite.invalidate();
        }
        if (modelId) await queryUtils.model.getById.invalidate({ id: modelId });
      }
    };

    Router.events.on('routeChangeStart', handleBrowsingAway);
    return () => {
      Router.events.off('routeChangeStart', handleBrowsingAway);
    };
  }, [modelVersionId, modelId, postId]); // eslint-disable-line

  return (
    <StoreContext.Provider value={store}>
      <ParamsContext.Provider value={mergedParams}>
        <PostPreviewProvider>
          <FileUploadProvider>{children}</FileUploadProvider>
        </PostPreviewProvider>
      </ParamsContext.Provider>
    </StoreContext.Provider>
  );
}

// #endregion

type PostPreviewState = {
  showPreview: boolean;
  toggleShowPreview: (value?: boolean) => void;
};
const PostPreviewContext = createContext<PostPreviewState | null>(null);
export function usePostPreviewContext() {
  const context = useContext(PostPreviewContext);
  if (!context) throw new Error('missing PostPreviewContext');
  return context;
}

function PostPreviewProvider({ children }: { children: React.ReactNode }) {
  const [showPreview, setShowPreview] = useLocalStorage({
    key: 'post-preview',
    defaultValue: false,
  });
  function toggleShowPreview(value?: boolean) {
    setShowPreview((o) => (value !== undefined ? !value : !o));
  }
  return (
    <PostPreviewContext.Provider value={{ showPreview, toggleShowPreview }}>
      {children}
    </PostPreviewContext.Provider>
  );
}
