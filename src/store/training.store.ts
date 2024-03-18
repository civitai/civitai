import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { AutoTagSchemaType } from '~/components/Training/Form/TrainingAutoTagModal';

export type ImageDataType = {
  url: string;
  name: string;
  type: string;
  caption: string;
};

type UpdateImageDataType = Partial<ImageDataType> & {
  matcher: string;
  appendCaption?: boolean;
};
export type AutoCaptionType = Nullable<AutoTagSchemaType> & {
  url: string | null;
  isRunning: boolean;
  total: number;
  successes: number;
  fails: string[];
};

type TrainingDataState = {
  imageList: ImageDataType[];
  initialImageList: ImageDataType[];
  ownRights: boolean;
  initialOwnRights: boolean;
  shareDataset: boolean;
  initialShareDataset: boolean;
  autoCaptioning: AutoCaptionType;
};

type TrainingImageStore = {
  [id: number]: TrainingDataState | undefined;
  updateImage: (modelId: number, data: UpdateImageDataType) => void;
  setImageList: (modelId: number, data: ImageDataType[]) => void;
  setInitialImageList: (modelId: number, data: ImageDataType[]) => void;
  setOwnRights: (modelId: number, data: boolean) => void;
  setShareDataset: (modelId: number, data: boolean) => void;
  setInitialOwnRights: (modelId: number, data: boolean) => void;
  setInitialShareDataset: (modelId: number, data: boolean) => void;
  setAutoCaptioning: (modelId: number, data: AutoCaptionType) => void;
};

export const defaultTrainingState: TrainingDataState = {
  imageList: [] as ImageDataType[],
  initialImageList: [] as ImageDataType[],
  ownRights: false,
  shareDataset: false,
  initialOwnRights: false,
  initialShareDataset: false,
  autoCaptioning: {
    maxTags: null,
    threshold: null,
    overwrite: null,
    blacklist: null,
    prependTags: null,
    appendTags: null,
    url: null,
    isRunning: false,
    total: 0,
    successes: 0,
    fails: [],
  },
};

export const getShortNameFromUrl = (i: ImageDataType) => {
  return `${i.url.split('/').pop() ?? 'unk'}.${i.type.split('/').pop() ?? 'jpg'}`;
};

export const useTrainingImageStore = create<TrainingImageStore>()(
  immer((set) => ({
    updateImage: (modelId, { matcher, url, name, type, caption, appendCaption }) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        // TODO [bw] why is this not understanding the override I just did above?
        state[modelId]!.imageList = state[modelId]!.imageList.map((i) => {
          const shortName = getShortNameFromUrl(i);
          if (shortName === matcher) {
            return {
              url: url ?? i.url,
              name: name ?? i.name,
              type: type ?? i.type,
              caption:
                caption !== undefined
                  ? appendCaption && i.caption.length > 0
                    ? `${i.caption}, ${caption}`
                    : caption
                  : i.caption,
            };
          }
          return i;
        });
      });
    },
    setImageList: (modelId, imgData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.imageList = imgData;
      });
    },
    setInitialImageList: (modelId, imgData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.initialImageList = imgData;
      });
    },
    setOwnRights: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.ownRights = v;
      });
    },
    setShareDataset: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.shareDataset = v;
      });
    },
    setInitialOwnRights: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.initialOwnRights = v;
      });
    },
    setInitialShareDataset: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.initialShareDataset = v;
      });
    },
    setAutoCaptioning: (modelId, captionData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.autoCaptioning = captionData;
      });
    },
  }))
);

const store = useTrainingImageStore.getState();
export const trainingStore = {
  updateImage: store.updateImage,
  setImageList: store.setImageList,
  setInitialImageList: store.setInitialImageList,
  setOwnRights: store.setOwnRights,
  setShareDataset: store.setShareDataset,
  setInitialOwnRights: store.setInitialOwnRights,
  setInitialShareDataset: store.setInitialShareDataset,
  setAutoCaptioning: store.setAutoCaptioning,
};
