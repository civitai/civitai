import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type SfwStore = {
  showReviews: Record<string, boolean>;
  showModels: Record<string, boolean>;
  showImages: Record<string, boolean>;
  toggleReview: (id: number) => void;
  toggleModel: (id: number) => void;
  toggleImage: (id: number) => void;
};

export const useSfwStore = create<SfwStore>()(
  immer((set) => ({
    showReviews: {},
    showModels: {},
    showImages: {},
    toggleReview: (id) => {
      set((state) => {
        state.showReviews[id.toString()] = !state.showReviews[id.toString()];
      });
    },
    toggleModel: (id) => {
      set((state) => {
        state.showModels[id.toString()] = !state.showModels[id.toString()];
      });
    },
    toggleImage: (id) => {
      set((state) => {
        state.showImages[id.toString()] = !state.showImages[id.toString()];
      });
    },
  }))
);
