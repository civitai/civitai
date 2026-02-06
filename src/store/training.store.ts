import * as z from 'zod';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ImageSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { trainingSettings } from '~/components/Training/Form/TrainingParams';
import type { constants } from '~/server/common/constants';
import type {
  TrainingDetailsBaseModel,
  TrainingDetailsObj,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { EngineTypes, TrainingBaseModelType } from '~/utils/training';

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
  negativePrompt?: string;
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
  updateImage: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: UpdateImageDataType
  ) => void;
  setImageList: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: ImageDataType[]
  ) => void;
  setInitialImageList: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: ImageDataType[]
  ) => void;
  setLabelType: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: LabelTypes
  ) => void;
  setTriggerWord: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: string
  ) => void;
  setTriggerWordInvalid: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: boolean
  ) => void;
  setOwnRights: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: boolean
  ) => void;
  setShareDataset: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: boolean
  ) => void;
  setAttest: (modelId: number, mediaType: TrainingDetailsObj['mediaType'], data: Attest) => void;
  setInitialLabelType: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: LabelTypes
  ) => void;
  setInitialTriggerWord: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: string
  ) => void;
  setInitialOwnRights: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: boolean
  ) => void;
  setInitialShareDataset: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: boolean
  ) => void;
  setAutoLabeling: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: Partial<AutoLabelType>
  ) => void;
  setAutoTagging: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: Partial<AutoTagSchemaType>
  ) => void;
  setAutoCaptioning: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data: Partial<AutoCaptionSchemaType>
  ) => void;
  addRun: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    data?: Omit<TrainingRun, 'id'>
  ) => void;
  removeRun: (modelId: number, mediaType: TrainingDetailsObj['mediaType'], data: number) => void;
  resetRuns: (modelId: number, mediaType: TrainingDetailsObj['mediaType']) => void;
  updateRun: (
    modelId: number,
    mediaType: TrainingDetailsObj['mediaType'],
    runId: number,
    data: TrainingRunUpdate
  ) => void;
};

export const defaultBase = 'sdxl';
export const defaultBaseType = 'sdxl' as const;
export const defaultEngine = 'kohya';

export const defaultBaseVideo = 'hy_720_fp8';
export const defaultBaseTypeVideo = 'hunyuan' as const;
export const defaultEngineVideo = 'musubi';

export const getDefaultTrainingParams = (base: TrainingDetailsBaseModel, engine: EngineTypes) => {
  return trainingSettings.reduce(
    (a, v) => ({
      ...a,
      [v.name]:
        v.overrides?.[base]?.all?.default ?? v.overrides?.[base]?.[engine]?.default ?? v.default,
    }),
    {} as TrainingDetailsParams
  );
};

const defaultRunBase = {
  id: 1,
  samplePrompts: ['', '', ''],
  negativePrompt:
    // Add default query.
    'bad quality, low quality, worst quality, jpeg artifacts, blurry, pixelated, out of focus, watermark, text, signature',
  staging: false,
  highPriority: false,
  buzzCost: 0,
  hasIssue: false,
};
export const defaultRun = {
  ...defaultRunBase,
  params: getDefaultTrainingParams(defaultBase, defaultEngine),
  base: defaultBase,
  baseType: defaultBaseType,
};
export const defaultRunVideo = {
  ...defaultRunBase,
  params: getDefaultTrainingParams(defaultBaseVideo, defaultEngineVideo),
  base: defaultBaseVideo,
  baseType: defaultBaseTypeVideo,
};

const defaultTrainingStateBase: Omit<TrainingDataState, 'labelType' | 'initialLabelType' | 'runs'> =
  {
    imageList: [] as ImageDataType[],
    initialImageList: [] as ImageDataType[],
    triggerWord: '',
    triggerWordInvalid: false,
    ownRights: false,
    shareDataset: false,
    attested: { status: false, error: '' },
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
  };
export const defaultTrainingState: TrainingDataState = {
  ...defaultTrainingStateBase,
  labelType: 'tag',
  initialLabelType: 'tag',
  runs: [{ ...defaultRun }],
};
export const defaultTrainingStateVideo: TrainingDataState = {
  ...defaultTrainingStateBase,
  labelType: 'caption',
  initialLabelType: 'caption',
  runs: [{ ...defaultRunVideo }],
};

export const getShortNameFromUrl = (i: ImageDataType) => {
  return `${i.url.split('/').pop() ?? 'unk'}.${i.type.split('/').pop() ?? 'jpg'}`;
};

const setModelState = (
  state: TrainingImageStore,
  modelId: number,
  mediaType: TrainingDetailsObj['mediaType']
) => {
  if (!state[modelId])
    state[modelId] = {
      ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
    };
  // TODO figure out how to tell TS that it exists now (no "!" below)
};

export const useTrainingImageStore = create<TrainingImageStore>()(
  immer((set) => ({
    updateImage: (
      modelId,
      mediaType,
      { matcher, url, name, type, label, appendLabel, invalidLabel, source }
    ) => {
      set((state) => {
        setModelState(state, modelId, mediaType);

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
    setImageList: (modelId, mediaType, imgData) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.imageList = imgData;
      });
    },
    setInitialImageList: (modelId, mediaType, imgData) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.initialImageList = imgData;
      });
    },
    setLabelType: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.labelType = v;
      });
    },
    setTriggerWord: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.triggerWord = v;
      });
    },
    setTriggerWordInvalid: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.triggerWordInvalid = v;
      });
    },
    setOwnRights: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.ownRights = v;
      });
    },
    setShareDataset: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.shareDataset = v;
      });
    },
    setAttest: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.attested = v;
      });
    },
    setInitialLabelType: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.initialLabelType = v;
      });
    },
    setInitialTriggerWord: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.initialTriggerWord = v;
      });
    },
    setInitialOwnRights: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.initialOwnRights = v;
      });
    },
    setInitialShareDataset: (modelId, mediaType, v) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.initialShareDataset = v;
      });
    },
    setAutoLabeling: (modelId, mediaType, labelData) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.autoLabeling = { ...state[modelId]!.autoLabeling, ...labelData };
      });
    },
    setAutoTagging: (modelId, mediaType, labelData) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.autoTagging = { ...state[modelId]!.autoTagging, ...labelData };
      });
    },
    setAutoCaptioning: (modelId, mediaType, labelData) => {
      set((state) => {
        setModelState(state, modelId, mediaType);
        state[modelId]!.autoCaptioning = { ...state[modelId]!.autoCaptioning, ...labelData };
      });
    },
    addRun: (modelId, mediaType, data) => {
      set((state) => {
        setModelState(state, modelId, mediaType);

        const lastNum = Math.max(1, ...state[modelId]!.runs.map((r) => r.id));
        const newData = data ?? (mediaType === 'video' ? defaultRunVideo : defaultRun);
        const newRun = {
          ...newData,
          id: lastNum + 1,
        };
        state[modelId]!.runs.push(newRun);
      });
    },
    removeRun: (modelId, mediaType, id) => {
      set((state) => {
        setModelState(state, modelId, mediaType);

        const thisState = state[modelId]!;
        // if (thisState.runs.length <= 1) return;
        const idx = thisState.runs.findIndex((r) => r.id === id);
        if (idx !== -1) {
          thisState.runs.splice(idx, 1);
        }
        if (thisState.runs.length === 0) {
          state[modelId]!.runs.push(mediaType === 'video' ? defaultRunVideo : defaultRun);
        }
      });
    },
    resetRuns: (modelId, mediaType) => {
      set((state) => {
        setModelState(state, modelId, mediaType);

        state[modelId]!.runs = [mediaType === 'video' ? defaultRunVideo : defaultRun];
      });
    },
    updateRun: (modelId, mediaType, runId, data) => {
      set((state) => {
        setModelState(state, modelId, mediaType);

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
          run.negativePrompt = data.negativePrompt ?? run.negativePrompt;
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
  resetRuns: store.resetRuns,
  updateRun: store.updateRun,
};
