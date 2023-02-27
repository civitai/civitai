import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type ImageState = {
  nsfw?: boolean;
  tosViolation?: boolean;
};

type ImageStore = {
  images: Record<string, ImageState>;
  setImage: (props: { id: number } & ImageState) => void;
};

export const useImageStore = create<ImageStore>()(
  immer((set, get) => ({
    images: {},
    setImage: ({ id, nsfw, tosViolation }) => {
      const key = id.toString();
      set((state) => {
        if (!state.images[key]) state.images[key] = {};
        if (nsfw) state.images[key].nsfw = nsfw;
        if (tosViolation) state.images[key].tosViolation = tosViolation;
      });
    },
  }))
);
