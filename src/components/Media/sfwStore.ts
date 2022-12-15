import create from 'zustand';
import { immer } from 'zustand/middleware/immer';

type SfwStore = {
  showReviews: Record<string, boolean>;
  showModels: Record<string, boolean>;
  toggleReview: (id: number) => void;
  toggleModel: (id: number) => void;
};

export const useSfwStore = create<SfwStore>()(
  immer((set) => ({
    showReviews: {},
    showModels: {},
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
  }))
);
