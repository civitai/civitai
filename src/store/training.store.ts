import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { AutoTagSchemaType } from '~/components/Training/Form/TrainingAutoTagModal';
import { trainingSettings } from '~/components/Training/Form/TrainingParams';
import type {
  TrainingDetailsBaseModel,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { Generation } from '~/server/services/generation/generation.types';

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

export type TrainingRun = {
  id: number;
  base: TrainingDetailsBaseModel;
  baseType: 'sd15' | 'sdxl';
  customModel?: Generation.Resource;
  samplePrompts: string[];
  params: TrainingDetailsParams;
  highPriority: boolean;
  staging: boolean;
  buzzCost: number;
};

type TrainingDataState = {
  imageList: ImageDataType[];
  initialImageList: ImageDataType[];
  ownRights: boolean;
  initialOwnRights: boolean;
  shareDataset: boolean;
  initialShareDataset: boolean;
  autoCaptioning: AutoCaptionType;
  runs: TrainingRun[];
};

export type TrainingRunUpdate = Partial<Omit<TrainingRun, 'id' | 'params' | 'customModel'>> & {
  params?: DeepPartial<TrainingRun['params']>;
  customModel?: TrainingRun['customModel'] | null;
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
  addRun: (modelId: number, data?: Omit<TrainingRun, 'id'>) => void;
  removeRun: (modelId: number, data: number) => void;
  updateRun: (modelId: number, runId: number, data: TrainingRunUpdate) => void;
};

export const defaultBase = 'sdxl';
export const defaultBaseType = 'sdxl' as const;
const defaultParams = trainingSettings.reduce(
  (a, v) => ({
    ...a,
    [v.name]: v.overrides?.[defaultBase]?.default ?? v.default,
  }),
  {} as TrainingDetailsParams
);
export const defaultRun = {
  id: 1,
  base: defaultBase,
  baseType: defaultBaseType,
  samplePrompts: ['', '', ''],
  params: { ...defaultParams },
  staging: false,
  highPriority: false,
  buzzCost: 0,
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
  runs: [{ ...defaultRun }],
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
    addRun: (modelId, data) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        const lastNum = Math.max(1, ...state[modelId]!.runs.map((r) => r.id));
        const newData = data ?? defaultRun;
        const newRun = {
          ...newData,
          id: lastNum + 1,
        };
        state[modelId]!.runs.push(newRun);
      });
    },
    removeRun: (modelId, id) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        const thisState = state[modelId]!;
        // if (thisState.runs.length <= 1) return;
        const idx = thisState.runs.findIndex((r) => r.id === id);
        if (idx !== -1) {
          thisState.runs.splice(idx, 1);
        }
        if (thisState.runs.length === 0) {
          state[modelId]!.runs.push(defaultRun);
        }
      });
    },
    updateRun: (modelId, runId, data) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        const run = state[modelId]!.runs.find((r) => r.id === runId);
        if (run) {
          run.base = data.base ?? run.base;
          run.baseType = data.baseType ?? run.baseType;
          run.customModel =
            data.customModel === null
              ? undefined
              : !!data.customModel
              ? data.customModel
              : run.customModel;
          run.samplePrompts = data.samplePrompts ?? run.samplePrompts;
          run.highPriority = data.highPriority ?? run.highPriority;
          run.staging = data.staging ?? run.staging;
          run.buzzCost = data.buzzCost ?? run.buzzCost;
          run.params = { ...run.params, ...data.params };
        }
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
  addRun: store.addRun,
  removeRun: store.removeRun,
  updateRun: store.updateRun,
};
