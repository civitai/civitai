import { PostDetailEditable } from '~/server/services/post.service';
import React, { createContext, useContext, useRef } from 'react';
import { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { mergeWithPartial } from '~/utils/object-helpers';
import { createStore, useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useDidUpdate } from '@mantine/hooks';
import { usePostEditContext } from '~/components/Post/EditV2/PostEditor';

// #region [Types]
export type ControlledImage = Partial<PostDetailEditable['images'][number]> &
  MediaUploadOnCompleteProps;
type StoreState = {
  isReordering: boolean;
  images: ControlledImage[];
  setImages: (cb: (images: ControlledImage[]) => ControlledImage[]) => void;
  updateImage: (data: Partial<Omit<ControlledImage, 'id'>> & { id: number }) => void;
  toggleReordering: () => void;
};
// #endregion

// #region [State]
type Store = ReturnType<typeof createProviderStore>;
const createProviderStore = (post?: PostDetailEditable) =>
  createStore<StoreState>()(
    immer((set) => ({
      isReordering: false,
      images: post?.images.map((data) => ({ status: 'added', ...data } as ControlledImage)) ?? [],
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
      toggleReordering: () =>
        set((state) => {
          state.isReordering = !state.isReordering;
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
export function PostImagesProvider({ children }: { children: React.ReactNode }) {
  const { post } = usePostEditContext();
  const storeRef = useRef<Store>();
  if (!storeRef.current) storeRef.current = createProviderStore(post);

  useDidUpdate(() => {
    if (post?.images)
      storeRef.current?.setState({
        images: post.images.map((data) => ({ status: 'added', ...data } as ControlledImage)),
      });
  }, [post]);

  return <Context.Provider value={storeRef.current}>{children}</Context.Provider>;
}

// #endregion
