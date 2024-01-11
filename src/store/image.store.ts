import { ImageIngestionStatus, NsfwLevel } from '@prisma/client';
import { useCallback } from 'react';
import { create } from 'zustand';
import { removeEmpty } from '~/utils/object-helpers';

type ImageProps = {
  nsfw?: NsfwLevel;
  tosViolation?: boolean;
  ingestion?: ImageIngestionStatus;
  blockedFor?: string | null;
};

type ImageStore = {
  [key: number]: ImageProps;
  setImage: (id: number, data: ImageProps) => void;
};

const useStore = create<ImageStore>((set) => ({
  setImage: (id, data) => set((state) => ({ [id]: { ...state[id], ...data } })),
}));

export const imageStore = {
  setImage: useStore.getState().setImage,
};

export const useImageStore = <T extends { id: number } & ImageProps>(image: T) => {
  const storedImage = useStore(useCallback((state) => state[image.id] ?? {}, [image.id]));
  return { ...image, ...removeEmpty(storedImage) };
};
