import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type StoreState = {
  data?: File[];
  setData: (data?: File[]) => void;
};

export const usePostImageTransmitterStore = create<StoreState>()(
  immer((set, get) => ({
    setData: (data) =>
      set((state) => {
        state.data = data;
      }),
  }))
);

const store = usePostImageTransmitterStore.getState();
export const postImageTransmitter = {
  setData: store.setData,
  getData: () => {
    const inStore = usePostImageTransmitterStore.getState().data;
    store.setData();
    return inStore;
  },
};
