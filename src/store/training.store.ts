import { z } from 'zod';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ImageSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { trainingSettings } from '~/components/Training/Form/TrainingParams';
import { constants } from '~/server/common/constants';
import type {
  TrainingDetailsBaseModel,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import type { TrainingBaseModelType } from '~/utils/training';

export type ImageDataType = {
  url: string;
  name: string;
  type: string;
  label: string;
  // labelType: LabelTypes;
  invalidLabel: boolean;
  source: { type: ImageSelectSource; url: string } | null;
};

type UpdateImageDataType = Partial<ImageDataType> & {
  matcher: string;
  appendLabel?: boolean;
};

// -- Auto Label
export type LabelTypes = (typeof constants.autoLabel.labelTypes)[number];

export const autoLabelLimits = {
  tag: {
    tags: {
      def: 10,
      min: 1,
      max: 30,
    },
    threshold: {
      def: 0.4,
      min: 0.3,
      max: 0.9,
    },
  },
  caption: {
    temperature: {
      def: 0.5,
      min: 0,
      max: 1,
    },
    maxNewTokens: {
      def: 100,
      min: 25,
      max: 500,
    },
  },
} as const;

export const overwriteList = ['ignore', 'append', 'overwrite'] as const;
const overwriteDefault = 'ignore';

const autoLabelSchema = z.object({
  overwrite: z.enum(overwriteList).default(overwriteDefault),
});
export const autoTagSchema = autoLabelSchema.extend({
  maxTags: z
    .number()
    .int()
    .min(autoLabelLimits.tag.tags.min)
    .max(autoLabelLimits.tag.tags.max)
    .default(autoLabelLimits.tag.tags.def),
  threshold: z
    .number()
    .min(autoLabelLimits.tag.threshold.min)
    .max(autoLabelLimits.tag.threshold.max)
    .default(autoLabelLimits.tag.threshold.def),
  blacklist: z.string().default(''),
  prependTags: z.string().default(''),
  appendTags: z.string().default(''),
});
export type AutoTagSchemaType = z.infer<typeof autoTagSchema>;
export const autoCaptionSchema = autoLabelSchema.extend({
  temperature: z
    .number()
    .min(autoLabelLimits.caption.temperature.min)
    .max(autoLabelLimits.caption.temperature.max)
    .default(autoLabelLimits.caption.temperature.def),
  maxNewTokens: z
    .number()
    .min(autoLabelLimits.caption.maxNewTokens.min)
    .max(autoLabelLimits.caption.maxNewTokens.max)
    .default(autoLabelLimits.caption.maxNewTokens.def),
});
export type AutoCaptionSchemaType = z.infer<typeof autoCaptionSchema>;

export type AutoLabelType = {
  url: string | null;
  isRunning: boolean;
  total: number;
  successes: number;
  fails: string[];
};

type Attest = { status: boolean; error: string };

//

export type TrainingRun = {
  id: number;
  base: TrainingDetailsBaseModel;
  baseType: TrainingBaseModelType;
  customModel?: GenerationResource;
  samplePrompts: string[];
  params: TrainingDetailsParams;
  highPriority: boolean;
  staging: boolean;
  buzzCost: number;
  hasIssue: boolean;
};

type TrainingDataState = {
  imageList: ImageDataType[];
  initialImageList: ImageDataType[];
  labelType: LabelTypes;
  triggerWord: string;
  triggerWordInvalid: boolean;
  ownRights: boolean;
  shareDataset: boolean;
  attested: Attest;
  initialLabelType: LabelTypes;
  initialTriggerWord: string;
  initialOwnRights: boolean;
  initialShareDataset: boolean;
  autoLabeling: AutoLabelType;
  autoTagging: AutoTagSchemaType;
  autoCaptioning: AutoCaptionSchemaType;
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
  setLabelType: (modelId: number, data: LabelTypes) => void;
  setTriggerWord: (modelId: number, data: string) => void;
  setTriggerWordInvalid: (modelId: number, data: boolean) => void;
  setOwnRights: (modelId: number, data: boolean) => void;
  setShareDataset: (modelId: number, data: boolean) => void;
  setAttest: (modelId: number, data: Attest) => void;
  setInitialLabelType: (modelId: number, data: LabelTypes) => void;
  setInitialTriggerWord: (modelId: number, data: string) => void;
  setInitialOwnRights: (modelId: number, data: boolean) => void;
  setInitialShareDataset: (modelId: number, data: boolean) => void;
  setAutoLabeling: (modelId: number, data: Partial<AutoLabelType>) => void;
  setAutoTagging: (modelId: number, data: Partial<AutoTagSchemaType>) => void;
  setAutoCaptioning: (modelId: number, data: Partial<AutoCaptionSchemaType>) => void;
  addRun: (modelId: number, data?: Omit<TrainingRun, 'id'>) => void;
  removeRun: (modelId: number, data: number) => void;
  updateRun: (modelId: number, runId: number, data: TrainingRunUpdate) => void;
};

export const defaultBase = 'sdxl';
export const defaultEngine = 'kohya';
export const defaultBaseType = 'sdxl' as const;
const defaultParams = trainingSettings.reduce(
  (a, v) => ({
    ...a,
    [v.name]:
      v.overrides?.[defaultBase]?.all?.default ??
      v.overrides?.[defaultBase]?.[defaultEngine]?.default ??
      v.default,
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
  hasIssue: false,
};

export const defaultTrainingState: TrainingDataState = {
  imageList: [] as ImageDataType[],
  initialImageList: [] as ImageDataType[],
  labelType: 'tag',
  triggerWord: '',
  triggerWordInvalid: false,
  ownRights: false,
  shareDataset: false,
  attested: { status: false, error: '' },
  initialLabelType: 'tag',
  initialTriggerWord: '',
  initialOwnRights: false,
  initialShareDataset: false,
  autoLabeling: {
    url: null,
    isRunning: false,
    total: 0,
    successes: 0,
    fails: [],
  },
  autoTagging: {
    overwrite: overwriteDefault,
    maxTags: autoLabelLimits.tag.tags.def,
    threshold: autoLabelLimits.tag.threshold.def,
    blacklist: '',
    prependTags: '',
    appendTags: '',
  },
  autoCaptioning: {
    overwrite: overwriteDefault,
    temperature: autoLabelLimits.caption.temperature.def,
    maxNewTokens: autoLabelLimits.caption.maxNewTokens.def,
  },
  runs: [{ ...defaultRun }],
};

export const getShortNameFromUrl = (i: ImageDataType) => {
  return `${i.url.split('/').pop() ?? 'unk'}.${i.type.split('/').pop() ?? 'jpg'}`;
};

export const useTrainingImageStore = create<TrainingImageStore>()(
  immer((set) => ({
    updateImage: (
      modelId,
      { matcher, url, name, type, label, appendLabel, invalidLabel, source }
    ) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        // why is this not understanding the override I just did above?
        state[modelId]!.imageList = state[modelId]!.imageList.map((i) => {
          const shortName = getShortNameFromUrl(i);
          if (shortName === matcher) {
            let newLabel = i.label;
            if (label !== undefined) {
              if (appendLabel && i.label.length > 0) {
                if (state[modelId]!.labelType === 'caption') {
                  newLabel = `${i.label}\n${label}`;
                } else {
                  newLabel = `${i.label}, ${label}`;
                }
              } else {
                newLabel = label;
              }
            }

            return {
              url: url ?? i.url,
              name: name ?? i.name,
              type: type ?? i.type,
              label: newLabel,
              invalidLabel: invalidLabel ?? i.invalidLabel,
              source: source ?? i.source,
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
    setLabelType: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.labelType = v;
      });
    },
    setTriggerWord: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.triggerWord = v;
      });
    },
    setTriggerWordInvalid: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.triggerWordInvalid = v;
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
    setAttest: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.attested = v;
      });
    },
    setInitialLabelType: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.initialLabelType = v;
      });
    },
    setInitialTriggerWord: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.initialTriggerWord = v;
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
    setAutoLabeling: (modelId, labelData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.autoLabeling = { ...state[modelId]!.autoLabeling, ...labelData };
      });
    },
    setAutoTagging: (modelId, labelData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.autoTagging = { ...state[modelId]!.autoTagging, ...labelData };
      });
    },
    setAutoCaptioning: (modelId, labelData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultTrainingState };
        state[modelId]!.autoCaptioning = { ...state[modelId]!.autoCaptioning, ...labelData };
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
          run.hasIssue = data.hasIssue ?? run.hasIssue;
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
  setLabelType: store.setLabelType,
  setTriggerWord: store.setTriggerWord,
  setTriggerWordInvalid: store.setTriggerWordInvalid,
  setOwnRights: store.setOwnRights,
  setShareDataset: store.setShareDataset,
  setAttest: store.setAttest,
  setInitialLabelType: store.setInitialLabelType,
  setInitialTriggerWord: store.setInitialTriggerWord,
  setInitialOwnRights: store.setInitialOwnRights,
  setInitialShareDataset: store.setInitialShareDataset,
  setAutoLabeling: store.setAutoLabeling,
  setAutoTagging: store.setAutoTagging,
  setAutoCaptioning: store.setAutoCaptioning,
  addRun: store.addRun,
  removeRun: store.removeRun,
  updateRun: store.updateRun,
};
