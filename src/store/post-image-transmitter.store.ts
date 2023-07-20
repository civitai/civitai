import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type FileType = { type: 'file'; files: File[] };
type UrlType = { type: 'url'; urls: string[] };
type DiscriminatedUnion = FileType | UrlType;

type StoreState = {
  data?: DiscriminatedUnion;
  setData: (data?: DiscriminatedUnion) => void;
};

const usePostImageTransmitter = create<StoreState>()(
  immer((set, get) => ({
    setData: (data) =>
      set((state) => {
        state.data = data;
      }),
  }))
);

const store = usePostImageTransmitter.getState();
const postImageTransmitter = {
  setData: store.setData,
};
