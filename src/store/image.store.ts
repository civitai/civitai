import create from 'zustand';
import { immer } from 'zustand/middleware/immer';

type ImageState = {
  nsfw?: boolean;
  deleted?: boolean;
  tosViolation?: boolean;
};

type ImageStore = {
  images: Record<string, ImageState>;
  setImage: (props: { id: number } & ImageState) => void;
};

const useImageStore = create<ImageStore>()(
  immer((set, get) => ({
    images: {},
    setImage: ({ id, nsfw, deleted, tosViolation }) => {
      const key = id.toString();
      set((state) => {
        if (nsfw) state.images[key].nsfw = nsfw;
        if (deleted) state.images[key].deleted = deleted;
        if (tosViolation) state.images[key].tosViolation = tosViolation;
      });
    },
  }))
);
