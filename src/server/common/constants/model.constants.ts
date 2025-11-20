import { ModelSort, MetricTimeframe, ModelStatus, NsfwLevel } from '~/server/common/enums';
import type { BaseModel } from '~/shared/constants/base-model.constants';

export const modelFilterDefaults = {
  sort: ModelSort.HighestRated,
  period: MetricTimeframe.AllTime,
};

export const modelFileTypes = [
  'Model',
  'Text Encoder',
  'Pruned Model',
  'Negative',
  'Training Data',
  'VAE',
  'Config',
  'Archive',
] as const;

export const trainingMediaTypes = ['image', 'video'] as const;
export const trainingModelTypes = ['Character', 'Style', 'Concept', 'Effect'] as const;
export const baseModelTypes = ['Standard', 'Inpainting', 'Refiner', 'Pix2Pix'] as const;
export const modelFileFormats = ['SafeTensor', 'PickleTensor', 'GGUF', 'Diffusers', 'Core ML', 'ONNX', 'Other'] as const;
export const modelFileSizes = ['full', 'pruned'] as const;
export const modelFileFp = ['fp16', 'fp8', 'nf4', 'fp32', 'bf16'] as const;
export const imageFormats = ['optimized', 'metadata'] as const;

export const modelFileOrder = {
  Model: 0,
  'Pruned Model': 1,
  'Training Data': 2,
  Config: 3,
  'Text Encoder': 4,
  VAE: 5,
  Negative: 6,
  Archive: 7,
};

export const modPublishOnlyStatuses = [ModelStatus.UnpublishedViolation, ModelStatus.Deleted] as ModelStatus[];

export const supportedBaseModelAddendums = ['SD 1.5', 'SDXL 1.0'];

export const zipModelFileTypes: ModelFileFormat[] = ['Core ML', 'Diffusers', 'ONNX'];
export type ZipModelFileType = (typeof zipModelFileTypes)[number];

export const maxTrainingRetries = 2;

export type BaseModelType = (typeof baseModelTypes)[number];
export type ModelFileType = (typeof modelFileTypes)[number];
export type ModelFileFormat = (typeof modelFileFormats)[number];

type LicenseDetails = {
  url: string;
  name: string;
  notice?: string;
  poweredBy?: string;
  restrictedNsfwLevels?: NsfwLevel[];
};

const baseLicenses: Record<string, LicenseDetails> = {
  openrail: {
    url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
    name: 'CreativeML Open RAIL-M',
  },
  'sdxl 0.9': {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL0.9',
    name: 'SDXL 0.9 research license',
  },
  'openrail++': {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL1.0',
    name: 'CreativeML Open RAIL++-M',
  },
  'sdxl turbo': {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL-Turbo',
    name: 'Stability AI Non-Commercial Research Community License',
    notice:
      'This Stability AI Model is licensed under the Stability AI Non-Commercial Research Community License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
  },
  svd: {
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDV',
    name: 'Stable Video Diffusion Non-Commercial Research Community License',
    notice:
      'Stable Video Diffusion is licensed under the Stable Video Diffusion Research License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
  },
  'playground v2': {
    url: 'https://huggingface.co/playgroundai/playground-v2-1024px-aesthetic/blob/main/LICENSE.md',
    name: 'Playground v2 Community License',
  },
  agpl: {
    url: 'https://github.com/PixArt-alpha/PixArt-alpha/blob/master/LICENSE',
    name: 'agpl-3.0',
  },
  'SAI NC RC': {
    url: 'https://huggingface.co/stabilityai/stable-cascade/blob/main/LICENSE',
    name: 'SAI NC RC',
    notice:
      'This Stability AI Model is licensed under the Stability AI Non-Commercial Research Community License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
  },
  'SAI CLA': {
    url: '',
    name: 'Stability AI Community License Agreement',
    notice:
      'This Stability AI Model is licensed under the Stability AI Community License, Copyright (c)  Stability AI Ltd. All Rights Reserved.',
    poweredBy: 'Powered by Stability AI',
    restrictedNsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
  },
  'hunyuan community': {
    url: 'https://github.com/Tencent/HunyuanDiT/blob/main/LICENSE.txt',
    name: 'Tencent Hunyuan Community License Agreement',
  },
  'hunyuan video': {
    url: 'https://huggingface.co/tencent/HunyuanVideo/blob/main/LICENSE',
    name: 'Tencent Hunyuan Community License Agreement',
    notice:
      'Tencent Hunyuan is licensed under the Tencent Hunyuan Community License Agreement, Copyright © 2024 Tencent. All Rights Reserved. The trademark rights of "Tencent Hunyuan" are owned by Tencent or its affiliate.',
    poweredBy: 'Powered by Tencent Hunyuan',
  },
  'kolors license': {
    url: 'https://raw.githubusercontent.com/Kwai-Kolors/Kolors/master/MODEL_LICENSE',
    name: 'Kolors License',
  },
  'apache 2.0': {
    url: 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/apache-2.0.md',
    name: 'Apache 2.0',
  },
  flux1D: {
    url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md',
    name: 'FLUX.1 [dev] Non-Commercial License',
    notice:
      'The FLUX.1 [dev] Model is licensed by Black Forest Labs. Inc. under the FLUX.1 [dev] Non-Commercial License. Copyright Black Forest Labs. Inc.',
    poweredBy:
      'IN NO EVENT SHALL BLACK FOREST LABS, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.',
  },
  'illustrious license': {
    url: 'https://freedevproject.org/faipl-1.0-sd/',
    name: 'Illustrious License',
  },
  'ltxv license': {
    url: 'https://huggingface.co/Lightricks/LTX-Video/blob/main/License.txt',
    name: 'LTX Video License',
  },
  'cogvideox license': {
    url: 'https://huggingface.co/THUDM/CogVideoX-5b/blob/main/LICENSE',
    name: 'CogVideoX License',
  },
  noobAi: {
    url: 'https://huggingface.co/Laxhar/noobai-XL-1.0/blob/main/README.md#model-license',
    name: 'NoobAI License',
  },
  mit: {
    url: 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md',
    name: 'MIT',
  },
  openai: {
    url: 'https://openai.com/policies/',
    name: 'OpenAI',
  },
  imagen4: {
    url: 'https://deepmind.google/about/responsibility-safety/',
    name: 'Imagen4',
  },
  veo3: {
    url: 'https://policies.google.com/terms',
    name: 'Veo 3',
  },
  seedream: {
    url: 'https://seed.bytedance.com/en/user-agreement',
    name: 'Seedream',
  },
  ponyV7: {
    url: 'https://purplesmart.ai/license',
    name: 'Pony',
  },
};

export const baseModelLicenses: Record<BaseModel, LicenseDetails | undefined> = {
  'SD 1.4': baseLicenses['openrail'],
  'SD 1.5': baseLicenses['openrail'],
  'SD 1.5 LCM': baseLicenses['openrail++'],
  'SD 1.5 Hyper': baseLicenses['openrail++'],
  'SD 2.0': baseLicenses['openrail'],
  'SD 2.0 768': baseLicenses['openrail'],
  'SD 2.1': baseLicenses['openrail'],
  'SD 2.1 768': baseLicenses['openrail'],
  'SD 2.1 Unclip': baseLicenses['openrail'],
  'SD 3': baseLicenses['SAI CLA'],
  'SD 3.5': baseLicenses['SAI CLA'],
  'SD 3.5 Medium': baseLicenses['SAI CLA'],
  'SD 3.5 Large': baseLicenses['SAI CLA'],
  'SD 3.5 Large Turbo': baseLicenses['SAI CLA'],
  'SDXL 0.9': baseLicenses['sdxl 0.9'],
  'SDXL 1.0': baseLicenses['openrail++'],
  'SDXL 1.0 LCM': baseLicenses['openrail++'],
  'SDXL Distilled': baseLicenses['openrail++'],
  'SDXL Turbo': baseLicenses['sdxl turbo'],
  'SDXL Lightning': baseLicenses['openrail++'],
  'SDXL Hyper': baseLicenses['openrail++'],
  SVD: baseLicenses['svd'],
  'SVD XT': baseLicenses['svd'],
  'Playground v2': baseLicenses['playground v2'],
  'PixArt a': baseLicenses['openrail++'],
  'PixArt E': baseLicenses['openrail++'],
  'Hunyuan 1': baseLicenses['hunyuan community'],
  'Hunyuan Video': baseLicenses['hunyuan video'],
  Lumina: baseLicenses['apache 2.0'],
  Kolors: baseLicenses['kolors license'],
  'Stable Cascade': baseLicenses['SAI NC RC'],
  Pony: baseLicenses['openrail++'],
  'Pony V7': baseLicenses['ponyV7'],
  AuraFlow: baseLicenses['apache 2.0'],
  Chroma: baseLicenses['apache 2.0'],
  'Flux.1 S': baseLicenses['apache 2.0'],
  'Flux.1 D': baseLicenses['flux1D'],
  'Flux.1 Krea': baseLicenses['flux1D'],
  'Flux.1 Kontext': baseLicenses['flux1D'],
  ODOR: undefined,
  Other: undefined,
  Illustrious: baseLicenses['illustrious license'],
  Mochi: baseLicenses['apache 2.0'],
  LTXV: baseLicenses['ltxv license'],
  CogVideoX: baseLicenses['cogvideox license'],
  NoobAI: baseLicenses['noobAi'],
  HiDream: baseLicenses['mit'],
  OpenAI: baseLicenses['openai'],
  'Nano Banana': baseLicenses['imagen4'],
  Imagen4: baseLicenses['imagen4'],
  'Veo 3': baseLicenses['veo3'],
  'Wan Video': baseLicenses['apache 2.0'],
  'Wan Video 1.3B t2v': baseLicenses['apache 2.0'],
  'Wan Video 14B t2v': baseLicenses['apache 2.0'],
  'Wan Video 14B i2v 480p': baseLicenses['apache 2.0'],
  'Wan Video 14B i2v 720p': baseLicenses['apache 2.0'],
  'Wan Video 2.2 I2V-A14B': baseLicenses['apache 2.0'],
  'Wan Video 2.2 T2V-A14B': baseLicenses['apache 2.0'],
  'Wan Video 2.2 TI2V-5B': baseLicenses['apache 2.0'],
  'Wan Video 2.5 T2V': baseLicenses['apache 2.0'],
  'Wan Video 2.5 I2V': baseLicenses['apache 2.0'],
  Qwen: baseLicenses['apache 2.0'],
  Seedream: baseLicenses['seedream'],
  'Sora 2': baseLicenses['openai'],
};

// Base models that use licenses with NSFW restrictions
export const nsfwRestrictedBaseModels: BaseModel[] = Object.entries(baseModelLicenses)
  .filter(
    ([, license]) =>
      license && license.restrictedNsfwLevels && license.restrictedNsfwLevels.length > 0
  )
  .map(([baseModel]) => baseModel as BaseModel);

export function getRestrictedNsfwLevelsForBaseModel(baseModel: string): NsfwLevel[] {
  const license = baseModelLicenses[baseModel as BaseModel];
  return license?.restrictedNsfwLevels || [];
}

export function isNsfwLevelRestrictedForBaseModel(
  baseModel: string,
  nsfwLevel: NsfwLevel
): boolean {
  const restrictedLevels = getRestrictedNsfwLevelsForBaseModel(baseModel);
  return restrictedLevels.includes(nsfwLevel);
}

export const modelGallery = {
  maxPinnedPosts: 20,
};
