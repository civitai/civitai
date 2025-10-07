import { lazy } from '~/shared/utils/lazy';
import { ModelType, type MediaType } from '~/shared/utils/prisma/enums';

type BaseModelConfigToSatisfy = {
  name: string;
  type: MediaType;
  group: string;
  hidden?: boolean;
  ecosystem?: string;
  engine?: string;
  family?: string;
};
type BaseModelConfig = typeof baseModelConfig;
export type BaseModel = BaseModelConfig[number]['name'];
export type BaseModelGroup = BaseModelConfig[number]['group'];

// type BaseModel
const baseModelConfig = [
  { name: 'AuraFlow', type: 'image', group: 'AuraFlow' },
  { name: 'Chroma', type: 'image', group: 'Chroma' },
  { name: 'CogVideoX', type: 'image', group: 'CogVideoX' },
  { name: 'Flux.1 S', type: 'image', group: 'Flux1' },
  { name: 'Flux.1 D', type: 'image', group: 'Flux1' },
  { name: 'Flux.1 Krea', type: 'image', group: 'FluxKrea' },
  { name: 'Flux.1 Kontext', type: 'image', group: 'Flux1Kontext' },
  { name: 'HiDream', type: 'image', group: 'HiDream' },
  { name: 'Hunyuan 1', type: 'image', group: 'HyDit1' },
  { name: 'Hunyuan Video', type: 'video', group: 'HyV1', engine: 'hunyuan' },
  { name: 'Illustrious', type: 'image', group: 'Illustrious', ecosystem: 'sdxl' },
  { name: 'Imagen4', type: 'image', group: 'Imagen4', hidden: true },
  { name: 'Kolors', type: 'image', group: 'Kolors' },
  { name: 'LTXV', type: 'video', group: 'LTXV', engine: 'lightricks' },
  { name: 'Lumina', type: 'image', group: 'Lumina' },
  { name: 'Mochi', type: 'image', group: 'Mochi' },
  { name: 'Nano Banana', type: 'image', group: 'NanoBanana', hidden: true },
  { name: 'NoobAI', type: 'image', group: 'NoobAI', ecosystem: 'sdxl' },
  { name: 'ODOR', type: 'image', group: 'ODOR', hidden: true },
  { name: 'OpenAI', type: 'image', group: 'OpenAI', hidden: true },
  { name: 'Other', type: 'image', group: 'Other' },
  { name: 'PixArt a', type: 'image', group: 'PixArtA' },
  { name: 'PixArt E', type: 'image', group: 'PixArtE' },
  {
    name: 'Playground v2',
    type: 'image',
    group: 'PlaygroundV2',
    hidden: true,
  },
  { name: 'Pony', type: 'image', group: 'Pony', ecosystem: 'sdxl' },
  { name: 'Pony V7', type: 'image', group: 'PonyV7', ecosystem: 'auraflow', hidden: true },
  { name: 'Qwen', type: 'image', group: 'Qwen', ecosystem: 'qwen' },
  {
    name: 'Stable Cascade',
    type: 'image',
    group: 'SCascade',
    hidden: true,
  },
  { name: 'SD 1.4', type: 'image', group: 'SD1' },
  { name: 'SD 1.5', type: 'image', group: 'SD1' },
  { name: 'SD 1.5 LCM', type: 'image', group: 'SD1' },
  { name: 'SD 1.5 Hyper', type: 'image', group: 'SD1' },
  { name: 'SD 2.0', type: 'image', group: 'SD2' },
  { name: 'SD 2.0 768', type: 'image', group: 'SD2', hidden: true },
  { name: 'SD 2.1', type: 'image', group: 'SD2' },
  { name: 'SD 2.1 768', type: 'image', group: 'SD2', hidden: true },
  { name: 'SD 2.1 Unclip', type: 'image', group: 'SD2', hidden: true },
  { name: 'SD 3', type: 'image', group: 'SD3' },
  { name: 'SD 3.5', type: 'image', group: 'SD3' },
  { name: 'SD 3.5 Large', type: 'image', group: 'SD3' },
  { name: 'SD 3.5 Large Turbo', type: 'image', group: 'SD3' },
  { name: 'SD 3.5 Medium', type: 'image', group: 'SD3_5M', ecosystem: 'sd3' },
  { name: 'SDXL 0.9', type: 'image', group: 'SDXL', hidden: true },
  { name: 'SDXL 1.0', type: 'image', group: 'SDXL' },
  { name: 'SDXL 1.0 LCM', type: 'image', group: 'SDXL', hidden: true },
  { name: 'SDXL Lightning', type: 'image', group: 'SDXL' },
  { name: 'SDXL Hyper', type: 'image', group: 'SDXL' },
  { name: 'SDXL Turbo', type: 'image', group: 'SDXL', hidden: true },
  {
    name: 'SDXL Distilled',
    type: 'image',
    group: 'SDXLDistilled',
    hidden: true,
  },
  { name: 'Seedream', type: 'image', group: 'Seedream', family: 'Bytedance', hidden: true },
  { name: 'SVD', type: 'image', group: 'SVD' },
  { name: 'SVD XT', type: 'image', group: 'SVD', hidden: true },
  { name: 'Veo 3', type: 'video', group: 'Veo3', hidden: true, engine: 'veo3' },
  { name: 'Wan Video', type: 'video', group: 'WanVideo', hidden: true, engine: 'wan' },
  { name: 'Wan Video 1.3B t2v', type: 'video', group: 'WanVideo1_3B_T2V', engine: 'wan' },
  { name: 'Wan Video 14B t2v', type: 'video', group: 'WanVideo14B_T2V', engine: 'wan' },
  { name: 'Wan Video 14B i2v 480p', type: 'video', group: 'WanVideo14B_I2V_480p', engine: 'wan' },
  { name: 'Wan Video 14B i2v 720p', type: 'video', group: 'WanVideo14B_I2V_720p', engine: 'wan' },
  { name: 'Wan Video 2.2 TI2V-5B', type: 'video', group: 'WanVideo-22-TI2V-5B', engine: 'wan' },
  { name: 'Wan Video 2.2 I2V-A14B', type: 'video', group: 'WanVideo-22-I2V-A14B', engine: 'wan' },
  { name: 'Wan Video 2.2 T2V-A14B', type: 'video', group: 'WanVideo-22-T2V-A14B', engine: 'wan' },
  { name: 'Wan Video 2.5 T2V', type: 'video', group: 'WanVideo-25-T2V', engine: 'wan' },
  { name: 'Wan Video 2.5 I2V', type: 'video', group: 'WanVideo-25-I2V', engine: 'wan' },
] as const satisfies BaseModelConfigToSatisfy[];

const groupNameOverrides: { name: string; groups: BaseModelGroup[] }[] = [
  { name: 'Stable Diffusion', groups: ['SD1', 'SD2', 'SD3', 'SD3_5M'] },
  { name: 'Stable Diffusion XL', groups: ['SDXL', 'SDXLDistilled', 'Pony'] },
  { name: 'Flux', groups: ['Flux1'] },
  { name: 'Flux Kontext', groups: ['Flux1Kontext'] },
  { name: 'PixArt alpha', groups: ['PixArtA'] },
  { name: 'PixArt sigma', groups: ['PixArtE'] },
  { name: 'Hunyuan DiT', groups: ['HyDit1'] },
  { name: 'Hunyuan Video', groups: ['HyV1'] },
  { name: 'Stable Cascade', groups: ['SCascade'] },
  {
    name: 'Wan Video',
    groups: [
      'WanVideo',
      'WanVideo1_3B_T2V',
      'WanVideo14B_T2V',
      'WanVideo14B_I2V_480p',
      'WanVideo14B_I2V_720p',
      'WanVideo-22-I2V-A14B',
      'WanVideo-22-T2V-A14B',
      'WanVideo-22-TI2V-5B',
      'WanVideo-25-T2V',
      'WanVideo-25-I2V',
    ],
  },
];

export const baseModels = baseModelConfig.map((x) => x.name);
export const baseModelGroups = [...new Set(baseModelConfig.map((x) => x.group))];
export const activeBaseModels = baseModelConfig
  .filter((x) => !('hidden' in x) || !x.hidden)
  .map((x) => x.name);

export function getBaseModelConfig(baseModel: string) {
  const config = baseModelConfig.find((x) => x.name === baseModel || x.group === baseModel);
  if (!config) return baseModelConfig.find((x) => x.group === 'Other')!;
  return config;
}

export function getBaseModelGroup(baseModel: string) {
  return getBaseModelConfig(baseModel).group;
}

export function getBaseModelSeoName(baseModel?: string) {
  if (!baseModel) return groupNameOverrides[0].name;
  const group = getBaseModelGroup(baseModel);
  return group
    ? groupNameOverrides.find((x) => x.groups.includes(group))?.name ?? group
    : groupNameOverrides[0].name;
}

export function getBaseModelEcosystem(baseModel: string) {
  const config = getBaseModelConfig(baseModel);
  return 'ecosystem' in config ? config.ecosystem : config.group.toLocaleLowerCase();
}

export function getBaseModelMediaType(baseModel: string) {
  return getBaseModelConfig(baseModel)?.type;
}

export function getBaseModelEngine(baseModel: string) {
  const config = getBaseModelConfig(baseModel);
  return 'engine' in config ? config.engine : undefined;
}

export function getBaseModelConfigsByGroup(group: BaseModelGroup) {
  return baseModelConfig.filter((x) => x.group === group);
}

export function getBaseModelsByGroup(group: BaseModelGroup) {
  return getBaseModelConfigsByGroup(group).map((x) => x.name);
}

export function getBaseModelConfigsByMediaType(type: MediaType) {
  return baseModelConfig.filter((x) => x.type === type);
}

export function getBaseModelByMediaType(type: MediaType) {
  return getBaseModelConfigsByMediaType(type).map((x) => x.name);
}

export function getBaseModelGroupsByMediaType(type: MediaType) {
  return [...new Set(getBaseModelConfigsByMediaType(type).map((x) => x.group))];
}

type BaseModelSupport = { modelTypes: ModelType[]; baseModels: BaseModel[] };
type BaseModelGenerationConfig = {
  group: BaseModelGroup;
  support: BaseModelSupport[];
  partialSupport?: BaseModelSupport[];
};

const sdxlBaseModels = [
  'SDXL 0.9',
  'SDXL 1.0',
  'SDXL 1.0 LCM',
  'SDXL Lightning',
  'SDXL Hyper',
  'SDXL Turbo',
] as const satisfies BaseModel[];

const sdxlEcosystemPartialSupport = [
  'SDXL 0.9',
  'SDXL 1.0',
  'SDXL 1.0 LCM',
  'Pony',
  'Illustrious',
  'NoobAI',
] as const satisfies BaseModel[];

const baseModelGenerationConfig: BaseModelGenerationConfig[] = [
  {
    group: 'SD1',
    support: [
      {
        modelTypes: [
          ModelType.Checkpoint,
          ModelType.TextualInversion,
          ModelType.LORA,
          ModelType.DoRA,
          ModelType.LoCon,
          ModelType.VAE,
        ],
        baseModels: ['SD 1.4', 'SD 1.5', 'SD 1.5 LCM', 'SD 1.5 Hyper'],
      },
    ],
  },
  {
    group: 'SDXL',
    support: [
      {
        modelTypes: [
          ModelType.Checkpoint,
          ModelType.TextualInversion,
          ModelType.LORA,
          ModelType.DoRA,
          ModelType.LoCon,
          ModelType.VAE,
        ],
        baseModels: sdxlBaseModels,
      },
    ],
    partialSupport: [
      { modelTypes: [ModelType.TextualInversion], baseModels: ['SD 1.5'] },
      {
        modelTypes: [
          ModelType.TextualInversion,
          ModelType.LORA,
          ModelType.DoRA,
          ModelType.LoCon,
          ModelType.VAE,
        ],
        baseModels: ['Pony', 'Illustrious', 'NoobAI'],
      },
    ],
  },
  {
    group: 'Pony',
    support: [
      {
        modelTypes: [
          ModelType.Checkpoint,
          ModelType.TextualInversion,
          ModelType.LORA,
          ModelType.DoRA,
          ModelType.LoCon,
          ModelType.VAE,
        ],
        baseModels: ['Pony'],
      },
    ],
    partialSupport: [
      { modelTypes: [ModelType.TextualInversion], baseModels: ['SD 1.5'] },
      {
        modelTypes: [ModelType.TextualInversion, ModelType.LORA, ModelType.DoRA, ModelType.LoCon],
        baseModels: sdxlEcosystemPartialSupport,
      },
      {
        modelTypes: [ModelType.VAE],
        baseModels: sdxlBaseModels,
      },
    ],
  },
  {
    group: 'PonyV7',
    support: [
      {
        modelTypes: [ModelType.Checkpoint],
        baseModels: ['Pony V7'],
      },
    ],
  },
  {
    group: 'Illustrious',
    support: [
      {
        modelTypes: [
          ModelType.Checkpoint,
          ModelType.TextualInversion,
          ModelType.LORA,
          ModelType.DoRA,
          ModelType.LoCon,
          ModelType.VAE,
        ],
        baseModels: ['Illustrious'],
      },
    ],
    partialSupport: [
      { modelTypes: [ModelType.TextualInversion], baseModels: ['SD 1.5'] },
      {
        modelTypes: [ModelType.TextualInversion, ModelType.LORA, ModelType.DoRA, ModelType.LoCon],
        baseModels: sdxlEcosystemPartialSupport,
      },
      {
        modelTypes: [ModelType.VAE],
        baseModels: sdxlBaseModels,
      },
    ],
  },
  {
    group: 'Chroma',
    support: [
      {
        modelTypes: [
          ModelType.Checkpoint,
          ModelType.TextualInversion,
          ModelType.LORA,
          ModelType.DoRA,
          ModelType.LoCon,
          ModelType.VAE,
        ],
        baseModels: ['Chroma'],
      },
    ],
  },
  {
    group: 'NoobAI',
    support: [
      {
        modelTypes: [
          ModelType.Checkpoint,
          ModelType.TextualInversion,
          ModelType.LORA,
          ModelType.DoRA,
          ModelType.LoCon,
          ModelType.VAE,
        ],
        baseModels: ['NoobAI'],
      },
    ],
    partialSupport: [
      { modelTypes: [ModelType.TextualInversion], baseModels: ['SD 1.5'] },
      {
        modelTypes: [ModelType.TextualInversion, ModelType.LORA, ModelType.DoRA, ModelType.LoCon],
        baseModels: sdxlEcosystemPartialSupport,
      },
      {
        modelTypes: [ModelType.VAE],
        baseModels: sdxlBaseModels,
      },
    ],
  },
  {
    group: 'Flux1',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.1 S', 'Flux.1 D'],
      },
    ],
    partialSupport: [{ modelTypes: [ModelType.LORA], baseModels: ['Flux.1 Krea'] }],
  },
  {
    group: 'FluxKrea',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.1 Krea'],
      },
    ],
    partialSupport: [{ modelTypes: [ModelType.LORA], baseModels: ['Flux.1 D'] }],
  },
  {
    group: 'Flux1Kontext',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Flux.1 Kontext'] }],
  },
  {
    group: 'HiDream',
    support: [{ modelTypes: [ModelType.Checkpoint, ModelType.LORA], baseModels: ['HiDream'] }],
  },
  {
    group: 'HyV1',
    support: [{ modelTypes: [ModelType.LORA], baseModels: ['Hunyuan Video'] }],
  },
  { group: 'Imagen4', support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Imagen4'] }] },
  {
    group: 'OpenAI',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['OpenAI'] }],
  },
  {
    group: 'NanoBanana',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Nano Banana'] }],
  },
  {
    group: 'Qwen',
    support: [{ modelTypes: [ModelType.Checkpoint, ModelType.LORA], baseModels: ['Qwen'] }],
  },
  {
    group: 'Seedream',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Seedream'] }],
  },
  {
    group: 'WanVideo',
    support: [{ modelTypes: [ModelType.LORA], baseModels: ['Wan Video'] }],
  },
  {
    group: 'WanVideo14B_T2V',
    support: [
      { modelTypes: [ModelType.Checkpoint, ModelType.LORA], baseModels: ['Wan Video 14B t2v'] },
    ],
    partialSupport: [
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['Wan Video 2.2 T2V-A14B', 'Wan Video 2.2 I2V-A14B', 'Wan Video 2.2 TI2V-5B'],
      },
    ],
  },
  {
    group: 'WanVideo14B_I2V_480p',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Wan Video 14B i2v 480p'],
      },
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['Wan Video 14B i2v 720p'],
      },
    ],
    partialSupport: [
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['Wan Video 2.2 T2V-A14B', 'Wan Video 2.2 I2V-A14B', 'Wan Video 2.2 TI2V-5B'],
      },
    ],
  },
  {
    group: 'WanVideo14B_I2V_720p',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Wan Video 14B i2v 720p'],
      },
    ],
    partialSupport: [
      { modelTypes: [ModelType.LORA], baseModels: ['Wan Video 14B i2v 480p'] },
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['Wan Video 2.2 T2V-A14B', 'Wan Video 2.2 I2V-A14B', 'Wan Video 2.2 TI2V-5B'],
      },
    ],
  },
  {
    group: 'WanVideo-22-T2V-A14B',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Wan Video 2.2 T2V-A14B'],
      },
    ],
    partialSupport: [
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['Wan Video 14B t2v', 'Wan Video 14B i2v 480p', 'Wan Video 14B i2v 720p'],
      },
    ],
  },
  {
    group: 'WanVideo-22-I2V-A14B',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Wan Video 2.2 I2V-A14B'],
      },
    ],
    partialSupport: [
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['Wan Video 14B t2v', 'Wan Video 14B i2v 480p', 'Wan Video 14B i2v 720p'],
      },
    ],
  },
  {
    group: 'WanVideo-22-TI2V-5B',
    support: [
      { modelTypes: [ModelType.Checkpoint, ModelType.LORA], baseModels: ['Wan Video 2.2 TI2V-5B'] },
    ],
    partialSupport: [
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['Wan Video 14B t2v', 'Wan Video 14B i2v 480p', 'Wan Video 14B i2v 720p'],
      },
    ],
  },
  {
    group: 'WanVideo-25-T2V',
    support: [
      {
        modelTypes: [ModelType.Checkpoint],
        baseModels: ['Wan Video 2.5 T2V'],
      },
    ],
  },
  {
    group: 'WanVideo-25-I2V',
    support: [
      {
        modelTypes: [ModelType.Checkpoint],
        baseModels: ['Wan Video 2.5 I2V'],
      },
    ],
  },
  {
    group: 'Veo3',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Veo 3'] }],
  },
];

type BaseModelSupportType = 'full' | 'partial';
type BaseModelSupportMapped = { baseModel: BaseModel; support: BaseModelSupportType };

export const getBaseModelGenerationConfig = lazy(() =>
  baseModelGroups.map((group) => {
    const groupConfig = baseModelGenerationConfig.find((x) => x.group === group);
    if (!groupConfig) return { group, supportMap: new Map<ModelType, BaseModelSupportMapped[]>() };
    else {
      const { group, support, partialSupport = [] } = groupConfig;
      const supportMap = new Map<ModelType, BaseModelSupportMapped[]>();
      for (const [index, list] of [support, partialSupport].entries()) {
        const supportType: BaseModelSupportType = index === 0 ? 'full' : 'partial';
        for (const { modelTypes, baseModels } of list) {
          for (const modelType of modelTypes) {
            const current = supportMap.get(modelType) ?? [];
            const toAdd = baseModels.map((baseModel) => ({ baseModel, support: supportType }));
            supportMap.set(modelType, [...new Set([...current, ...toAdd])]);
          }
        }
      }

      return { group, supportMap };
    }
  })
);

export function getGenerationBaseModelsByMediaType(type: MediaType) {
  const baseModels = getBaseModelByMediaType(type);
  const generationBaseModels = getBaseModelGenerationConfig().flatMap(({ supportMap }) =>
    [...supportMap.values()].flatMap((entry) => entry.map((x) => x.baseModel))
  );
  return baseModels.filter((baseModel) => generationBaseModels.includes(baseModel));
}

export function getGenerationBaseModelGroup(baseModel: string, missedMatch?: boolean) {
  const group = getBaseModelGenerationConfig().find((x) => x.group === baseModel);
  if (!group && !missedMatch) {
    const match = baseModelConfig.find((x) => x.name === baseModel);
    if (match) return getGenerationBaseModelGroup(match.group, true);
  }
  return group;
}

export type GenerationBaseModelResourceOptions = {
  type: ModelType;
  baseModels: BaseModel[];
  partialSupport: BaseModel[];
};
export function getGenerationBaseModelResourceOptions(
  groupName: BaseModelGroup
): GenerationBaseModelResourceOptions[] {
  const group = getGenerationBaseModelGroup(groupName);
  if (!group) return [];

  return [...group.supportMap.entries()].map(([modelType, mapped]) => ({
    type: modelType,
    baseModels: [...new Set(mapped.filter((x) => x.support === 'full').map((x) => x.baseModel))],
    partialSupport: [
      ...new Set(mapped.filter((x) => x.support === 'partial').map((x) => x.baseModel)),
    ],
  }));
}

export function getGenerationBaseModels(group: string, modelType: ModelType) {
  const match = getGenerationBaseModelGroup(group);
  return match?.supportMap.get(modelType)?.map((x) => x.baseModel) ?? [];
}

export function getGenerationBaseModelAssociatedGroups(group: string, modelType: ModelType) {
  const baseModels = getGenerationBaseModels(group, modelType);
  return [
    ...new Set(baseModelConfig.filter((x) => baseModels.includes(x.name)).map((x) => x.group)),
  ];
}

/**
 * identify the base model distribution by model type
 * ie. { Checkpoint: ['Illustrious'], LORA: ['Illustrious'], TextualInversion: ['SD 1.5] }
 */
export function getBaseModelsByModelType(args: { modelType: ModelType; baseModel: BaseModel }[]) {
  return args.reduce(
    (acc, { modelType, baseModel }) => ({
      ...acc,
      [modelType]: [...(acc[modelType] ?? []), baseModel],
    }),
    {} as Record<ModelType, BaseModel[]>
  );
}
