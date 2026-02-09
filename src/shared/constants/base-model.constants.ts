import { lazy } from '~/shared/utils/lazy';
import { ModelType, type MediaType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

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

export const baseModelFamilyConfig: Record<
  string,
  { name: string; description: string; disabled?: boolean }
> = {
  Flux: {
    name: 'Flux',
    description: "Black Forest Labs' family of state-of-the-art image generation models",
  },
  StableDiffusion: {
    name: 'Stable Diffusion',
    description: "Stability AI's foundational open-source diffusion models",
  },
  SDXLCommunity: {
    name: 'SDXL Community',
    description: 'Community-trained models built on the SDXL architecture',
  },
  Hunyuan: {
    name: 'Hunyuan',
    description: "Tencent's family of image and video generation models",
  },
  WanVideo: {
    name: 'Wan Video',
    description: "Alibaba's video generation model series with various sizes and modes",
  },
  PixArt: {
    name: 'PixArt',
    description: 'Efficient transformer-based text-to-image models',
  },
  Google: {
    name: 'Google',
    description: "Google's image and video generation models",
  },
  OpenAI: {
    name: 'OpenAI',
    description: "OpenAI's creative image and video generation models",
  },
  Pony: {
    name: 'Pony Diffusion',
    description: 'Community models with extensive tag-based prompt support',
  },
  Qwen: {
    name: 'Qwen',
    description: "Alibaba's multimodal model family with image generation capabilities",
    disabled: true,
  },
  ZImage: {
    name: 'ZImage',
    description: 'Z Image generation models',
  },
};

export type BaseModelFamily = keyof typeof baseModelFamilyConfig;

// type BaseModel
const baseModelConfig = [
  { name: 'Anima', type: 'image', group: 'Anima' },
  { name: 'AuraFlow', type: 'image', group: 'AuraFlow' },
  { name: 'Chroma', type: 'image', group: 'Chroma' },
  { name: 'CogVideoX', type: 'image', group: 'CogVideoX' },
  { name: 'Flux.1 S', type: 'image', group: 'Flux1' },
  { name: 'Flux.1 D', type: 'image', group: 'Flux1' },
  { name: 'Flux.1 Krea', type: 'image', group: 'FluxKrea' },
  { name: 'Flux.1 Kontext', type: 'image', group: 'Flux1Kontext' },
  { name: 'Flux.2 D', type: 'image', group: 'Flux2' },
  { name: 'Flux.2 Klein 9B', type: 'image', group: 'Flux2Klein_9B' },
  { name: 'Flux.2 Klein 9B-base', type: 'image', group: 'Flux2Klein_9B_base' },
  { name: 'Flux.2 Klein 4B', type: 'image', group: 'Flux2Klein_4B' },
  { name: 'Flux.2 Klein 4B-base', type: 'image', group: 'Flux2Klein_4B_base' },
  { name: 'HiDream', type: 'image', group: 'HiDream' },
  { name: 'Hunyuan 1', type: 'image', group: 'HyDit1' },
  { name: 'Hunyuan Video', type: 'video', group: 'HyV1', engine: 'hunyuan' },
  { name: 'Illustrious', type: 'image', group: 'Illustrious', ecosystem: 'sdxl' },
  { name: 'Imagen4', type: 'image', group: 'Imagen4', hidden: true },
  { name: 'Kling', type: 'video', group: 'Kling', hidden: true, engine: 'kling' },
  { name: 'Kolors', type: 'image', group: 'Kolors' },
  { name: 'LTXV', type: 'video', group: 'LTXV', engine: 'lightricks' },
  { name: 'LTXV2', type: 'video', group: 'LTXV2', engine: 'ltx2' },
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
  { name: 'Pony V7', type: 'image', group: 'PonyV7', ecosystem: 'auraflow' },
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
  { name: 'SD 3', type: 'image', group: 'SD3', hidden: true },
  { name: 'SD 3.5', type: 'image', group: 'SD3', hidden: true },
  { name: 'SD 3.5 Large', type: 'image', group: 'SD3', hidden: true },
  { name: 'SD 3.5 Large Turbo', type: 'image', group: 'SD3', hidden: true },
  { name: 'SD 3.5 Medium', type: 'image', group: 'SD3_5M', ecosystem: 'sd3', hidden: true },
  { name: 'Sora 2', type: 'video', group: 'Sora2', hidden: true },
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
  { name: 'SVD', type: 'image', group: 'SVD', hidden: true },
  { name: 'SVD XT', type: 'image', group: 'SVD', hidden: true },
  { name: 'Veo 3', type: 'video', group: 'Veo3', hidden: true, engine: 'veo3' },
  { name: 'Vidu Q1', type: 'video', group: 'Vidu', hidden: true, engine: 'vidu' },
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
  { name: 'ZImageTurbo', type: 'image', group: 'ZImageTurbo', ecosystem: 'zimageturbo' },
  { name: 'ZImageBase', type: 'image', group: 'ZImageBase', ecosystem: 'zimagebase' },
] as const satisfies BaseModelConfigToSatisfy[];

type BaseModelGroupConfigEntry = {
  name: string;
  description: string;
  family?: BaseModelFamily;
  selector?: string;
};

export const baseModelGroupConfig: Record<BaseModelGroup, BaseModelGroupConfigEntry> = {
  Anima: {
    name: 'Anima',
    description:
      'Anima is an open-source image generation model with strong foundational capabilities, designed to provide high-quality outputs across a wide range of prompts and styles.',
  },
  AuraFlow: {
    name: 'AuraFlow',
    description: 'Open-source text-to-image model from Fal.ai with strong prompt adherence',
  },
  Chroma: {
    name: 'Chroma',
    description: 'Open-source model based on Flux architecture with improved color and composition',
  },
  CogVideoX: {
    name: 'CogVideoX',
    description: 'Text-to-video diffusion model from Tsinghua University and ZhipuAI',
  },
  Flux1: {
    name: 'Flux.1',
    family: 'Flux',
    description: 'First generation Flux with schnell and dev variants',
  },
  FluxKrea: {
    name: 'Flux.1 Krea',
    family: 'Flux',
    description: 'Krea-trained variant of Flux optimized for creative generation',
  },
  Flux1Kontext: {
    name: 'Flux.1 Kontext',
    family: 'Flux',
    description: 'Flux variant specialized for context-aware image editing and generation',
  },
  Flux2: {
    name: 'Flux.2',
    family: 'Flux',
    description: 'Next-generation Flux with enhanced capabilities',
  },
  Flux2Klein_9B: {
    name: 'Flux.2 Klein 9B',
    family: 'Flux',
    description: 'Distilled 9B parameter Flux.2 model for faster generation',
    selector: 'Flux.2 Klein',
  },
  Flux2Klein_9B_base: {
    name: 'Flux.2 Klein 9B-base',
    family: 'Flux',
    description: 'Base 9B parameter Flux.2 Klein model',
    selector: 'Flux.2 Klein',
  },
  Flux2Klein_4B: {
    name: 'Flux.2 Klein 4B',
    family: 'Flux',
    description: 'Distilled 4B parameter Flux.2 model for efficient generation',
    selector: 'Flux.2 Klein',
  },
  Flux2Klein_4B_base: {
    name: 'Flux.2 Klein 4B-base',
    family: 'Flux',
    description: 'Base 4B parameter Flux.2 Klein model',
    selector: 'Flux.2 Klein',
  },
  HiDream: {
    name: 'HiDream',
    description: 'High-resolution image generation model optimized for detailed outputs',
  },
  HyDit1: {
    name: 'Hunyuan DiT',
    family: 'Hunyuan',
    description: 'Diffusion transformer for bilingual Chinese-English image generation',
  },
  HyV1: {
    name: 'Hunyuan Video',
    family: 'Hunyuan',
    description: 'Video generation model with strong motion coherence',
  },
  Illustrious: {
    name: 'Illustrious',
    family: 'SDXLCommunity',
    description: 'SDXL-based model specialized for anime and illustration styles',
  },
  Imagen4: {
    name: 'Imagen 4',
    family: 'Google',
    description: 'Text-to-image model with photorealistic capabilities',
  },
  Kling: {
    name: 'Kling',
    description: "Kuaishou's video generation model",
  },
  Kolors: {
    name: 'Kolors',
    description: "Kuaishou's bilingual image generation model with vibrant color output",
  },
  LTXV: {
    name: 'LTX Video',
    description: "Lightricks' efficient video generation model for fast rendering",
  },
  LTXV2: {
    name: 'LTX Video 2',
    description: "Lightricks' next-generation video model with improved quality and LoRA support",
  },
  Lumina: {
    name: 'Lumina',
    description: 'Open-source model with strong foundations',
  },
  Mochi: {
    name: 'Mochi',
    description: "Genmo's video generation model with realistic motion synthesis",
  },
  NanoBanana: {
    name: 'Nano Banana',
    family: 'Google',
    description: 'Experimental image generation model',
  },
  NoobAI: {
    name: 'NoobAI',
    family: 'SDXLCommunity',
    description: 'SDXL-based model trained for anime and stylized content',
  },
  ODOR: {
    name: 'ODOR',
    description: 'Experimental diffusion model architecture',
  },
  OpenAI: {
    name: 'OpenAI',
    family: 'OpenAI',
    description: 'Image generation models including DALL-E',
  },
  Other: {
    name: 'Other',
    description: "Models that don't fit into standard categories",
  },
  PixArtA: {
    name: 'PixArt Alpha',
    family: 'PixArt',
    description: 'Efficient transformer-based model with fast training and strong quality',
  },
  PixArtE: {
    name: 'PixArt Sigma',
    family: 'PixArt',
    description: 'Enhanced PixArt with 4K resolution support and improved detail',
  },
  PlaygroundV2: {
    name: 'Playground v2',
    description: "Playground AI's model optimized for aesthetic image generation",
  },
  Pony: {
    name: 'Pony Diffusion',
    family: 'Pony',
    description: 'SDXL-based model with extensive tag-based prompt support',
  },
  PonyV7: {
    name: 'Pony Diffusion V7',
    family: 'Pony',
    description: 'Latest Pony Diffusion built on AuraFlow architecture',
  },
  Qwen: {
    name: 'Qwen',
    family: 'Qwen',
    description: 'Multimodal model with image generation capabilities',
  },
  SCascade: {
    name: 'Stable Cascade',
    family: 'StableDiffusion',
    description: 'Cascaded latent diffusion model for high-resolution output',
  },
  SD1: {
    name: 'Stable Diffusion 1.x',
    family: 'StableDiffusion',
    description: 'The original Stable Diffusion with broad community support',
  },
  SD2: {
    name: 'Stable Diffusion 2.x',
    family: 'StableDiffusion',
    description: 'Second generation SD with improved architecture and 768px support',
  },
  SD3: {
    name: 'Stable Diffusion 3',
    family: 'StableDiffusion',
    description: 'Multimodal diffusion transformer architecture',
  },
  SD3_5M: {
    name: 'Stable Diffusion 3.5 Medium',
    family: 'StableDiffusion',
    description: 'Balanced SD3.5 variant optimized for quality and speed',
  },
  SDXL: {
    name: 'Stable Diffusion XL',
    family: 'StableDiffusion',
    description: 'High-resolution SD with improved prompt understanding and detail',
  },
  SDXLDistilled: {
    name: 'SDXL Distilled',
    family: 'StableDiffusion',
    description: 'Faster SDXL variants with reduced inference steps',
  },
  Seedream: {
    name: 'Seedream',
    description: "ByteDance's image generation model",
  },
  Sora2: {
    name: 'Sora 2',
    family: 'OpenAI',
    description: 'Advanced video generation model',
  },
  SVD: {
    name: 'Stable Video Diffusion',
    family: 'StableDiffusion',
    description: 'Image-to-video diffusion model',
  },
  Veo3: {
    name: 'Veo 3',
    family: 'Google',
    description: 'Latest video generation model from DeepMind',
  },
  Vidu: {
    name: 'Vidu Q1',
    description: 'High-quality video generation model from Vidu',
  },
  WanVideo: {
    name: 'Wan Video',
    family: 'WanVideo',
    description: 'Base video generation model',
  },
  WanVideo1_3B_T2V: {
    name: 'Wan Video 1.3B T2V',
    family: 'WanVideo',
    description: 'Lightweight text-to-video model',
  },
  WanVideo14B_T2V: {
    name: 'Wan Video 14B T2V',
    family: 'WanVideo',
    description: 'Full-scale text-to-video model',
  },
  WanVideo14B_I2V_480p: {
    name: 'Wan Video 14B I2V 480p',
    family: 'WanVideo',
    description: 'Image-to-video at 480p resolution',
  },
  WanVideo14B_I2V_720p: {
    name: 'Wan Video 14B I2V 720p',
    family: 'WanVideo',
    description: 'Image-to-video at 720p resolution',
  },
  'WanVideo-22-TI2V-5B': {
    name: 'Wan Video 2.2 TI2V 5B',
    family: 'WanVideo',
    description: 'Text/image-to-video 5B parameter model',
  },
  'WanVideo-22-I2V-A14B': {
    name: 'Wan Video 2.2 I2V A14B',
    family: 'WanVideo',
    description: 'Image-to-video 14B parameter model',
  },
  'WanVideo-22-T2V-A14B': {
    name: 'Wan Video 2.2 T2V A14B',
    family: 'WanVideo',
    description: 'Text-to-video 14B parameter model',
  },
  'WanVideo-25-T2V': {
    name: 'Wan Video 2.5 T2V',
    family: 'WanVideo',
    description: 'Latest text-to-video generation',
  },
  'WanVideo-25-I2V': {
    name: 'Wan Video 2.5 I2V',
    family: 'WanVideo',
    description: 'Latest image-to-video generation',
  },
  ZImageTurbo: {
    name: 'ZImageTurbo',
    family: 'ZImage',
    description: 'Fast turbo-optimized image generation model',
  },
  ZImageBase: {
    name: 'ZImageBase',
    family: 'ZImage',
    description: 'Base image generation model',
  },
};

const groupNameOverrides: { name: string; groups: BaseModelGroup[] }[] = [
  { name: 'Stable Diffusion', groups: ['SD1', 'SD2', 'SD3', 'SD3_5M'] },
  { name: 'Stable Diffusion XL', groups: ['SDXL', 'SDXLDistilled', 'Pony'] },
  { name: 'Flux', groups: ['Flux1'] },
  { name: 'Flux 2', groups: ['Flux2'] },
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

export function getActiveBaseModels(isModerator?: boolean) {
  return isModerator
    ? baseModelConfig
    : baseModelConfig.filter((x) => !('hidden' in x) || !x.hidden);
}

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
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
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
      { modelTypes: [ModelType.Checkpoint, ModelType.LORA], baseModels: ['Flux.1 Krea'] },
    ],
  },
  {
    group: 'FluxKrea',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.1 Krea'],
      },
      { modelTypes: [ModelType.Checkpoint, ModelType.LORA], baseModels: ['Flux.1 D'] },
    ],
  },
  {
    group: 'Flux1Kontext',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Flux.1 Kontext'] }],
  },
  {
    group: 'Flux2',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.2 D'],
      },
    ],
  },
  {
    group: 'Flux2Klein_9B',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.2 Klein 9B'],
      },
    ],
  },
  {
    group: 'Flux2Klein_9B_base',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.2 Klein 9B-base'],
      },
    ],
  },
  {
    group: 'Flux2Klein_4B',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.2 Klein 4B'],
      },
    ],
  },
  {
    group: 'Flux2Klein_4B_base',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['Flux.2 Klein 4B-base'],
      },
    ],
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
    group: 'Sora2',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Sora 2'] }],
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
  {
    group: 'Vidu',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Vidu Q1'] }],
  },
  {
    group: 'Kling',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['Kling'] }],
  },
  {
    group: 'LTXV',
    support: [{ modelTypes: [ModelType.Checkpoint], baseModels: ['LTXV'] }],
  },
  {
    group: 'LTXV2',
    support: [{ modelTypes: [ModelType.Checkpoint, ModelType.LORA], baseModels: ['LTXV2'] }],
  },
  {
    group: 'ZImageTurbo',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['ZImageTurbo'],
      },
    ],
    partialSupport: [
      {
        modelTypes: [ModelType.LORA],
        baseModels: ['ZImageBase'],
      },
    ],
  },
  {
    group: 'ZImageBase',
    support: [
      {
        modelTypes: [ModelType.Checkpoint, ModelType.LORA],
        baseModels: ['ZImageBase'],
      },
    ],
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

export function getGenerationBaseModelConfigs(type?: MediaType) {
  const generationBaseModelGroups = getBaseModelGenerationConfig()
    .filter(({ supportMap }) => supportMap.size > 0)
    .map(
      ({ group }) =>
        baseModelConfig.find(
          (config) => config.group === group && (type ? config.type === type : true)
        )?.group
    )
    .filter(isDefined);

  return generationBaseModelGroups;
}

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

export function getBaseModelGenerationSupported(baseModel: string, modelType: ModelType) {
  const group = getGenerationBaseModelGroup(baseModel);
  if (!group) return false;
  const support = group.supportMap.get(modelType)?.find((x) => x.baseModel === baseModel);
  return !!support;
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

// Base models that are deprecated and should not be published or updated
export const DEPRECATED_BASE_MODELS = [
  'SD 3',
  'SD 3.5',
  'SD 3.5 Medium',
  'SD 3.5 Large',
  'SD 3.5 Large Turbo',
  'SDXL Turbo',
  'SVD',
  'SVD XT',
] as const satisfies BaseModel[];

export function getCanAuctionForGeneration(baseModel?: string) {
  if (!baseModel) return false;
  const group = getGenerationBaseModelGroup(baseModel);
  return group ? !['Qwen', 'ZImageTurbo', 'ZImageBase', 'Other'].includes(group.group) : false;
}
