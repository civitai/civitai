import { createStore, StoreApi, useStore } from 'zustand';
import { createContext, useContext, useRef } from 'react';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuidv4 } from 'uuid';

type ImageType = { type: 'image' } & Image;
type Image = {
  id: number;
  url: string;
  name?: string;
  meta?: Record<string, unknown>;
  height?: number | null;
  width?: number | null;
  hash?: string;
  nsfw?: boolean;
  resources?: number;
};

type InitialDataType = ImageType;

type TrackdFileType = { type: 'tracked-file' } & TrackedFile;
type TrackedFile = {
  file: File;
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
  status: 'pending' | 'error' | 'success' | 'uploading' | 'aborted';
  abort: () => void;
  height: number;
  width: number;
  uuid: string;
};

type StoreItem = ImageType | TrackdFileType;

type StoreProps = {
  items: StoreItem[];
  reset: (data?: InitialDataType[]) => void;
  setItems: (items: StoreItem[]) => void;
};

const MyContext = createContext<StoreApi<StoreProps>>({} as any);

const createMyStore = () =>
  createStore<StoreProps>()(
    immer((set, get) => ({
      items: [],
      reset: (data) => {
        set((state) => {
          state.items = data ?? [];
        });
      },
      setItems: (data) => undefined,
    }))
  );

const PostMediaProvider = ({ children }: { children: React.ReactElement }) => {
  const store = useRef(createMyStore()).current;
  return <MyContext.Provider value={store}>{children}</MyContext.Provider>;
};
