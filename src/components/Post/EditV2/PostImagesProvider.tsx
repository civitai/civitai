import { PostDetailEditable } from '~/server/services/post.service';
import React, { createContext, useContext, useRef } from 'react';
import { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { mergeWithPartial } from '~/utils/object-helpers';
import { createStore, useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// #region [Types]
type ControlledImage = Partial<PostDetailEditable['images'][number]> & MediaUploadOnCompleteProps;
type StoreState = {
  postId: number;
  modelVersionId?: number;
  images: ControlledImage[];
  setImages: (cb: (images: ControlledImage[]) => ControlledImage[]) => void;
  updateImage: (data: Partial<Omit<ControlledImage, 'id'>> & { id: number }) => void;
};
// #endregion

// #region [State]
type Store = ReturnType<typeof createProviderStore>;
const createProviderStore = (post: PostDetailEditable) =>
  createStore<StoreState>()(
    immer((set) => ({
      postId: post.id,
      modelVersionId: post.modelVersionId ?? undefined,
      images: post.images.map((data) => ({ status: 'added', ...data } as ControlledImage)),
      setImages: (cb) =>
        set((state) => {
          state.images = cb(state.images);
        }),
      updateImage: (data) =>
        set((state) => {
          const index = state.images.findIndex((x) => x.id === data.id);
          if (index > -1)
            state.images[index] = mergeWithPartial(
              state.images[index],
              data as Partial<ControlledImage>
            );
        }),
    }))
  );
// #endregion

// #region [Context]
const Context = createContext<Store | null>(null);
export function usePostImagesContext<T>(selector: (state: StoreState) => T) {
  const store = useContext(Context);
  if (!store) throw new Error('missing PostImagesProvider');
  return useStore(store, selector);
}
// #endregion

// #region [Provider]
export function PostImagesProvider({
  children,
  post,
}: {
  children: React.ReactNode;
  post: PostDetailEditable;
}) {
  const storeRef = useRef<Store>();
  if (!storeRef.current) storeRef.current = createProviderStore(post);

  return <Context.Provider value={storeRef.current}>{children}</Context.Provider>;
}

// #endregion
