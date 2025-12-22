/**
 * Base Model Constants - DB-like Structure
 *
 * This file contains base model configuration data structured to match
 * the planned database schema. Each record includes generated IDs that
 * will be used when migrating to the database.
 *
 * @see docs/base-model-constants-management.md for migration plan
 */

import { ModelType, type MediaType } from '~/shared/utils/prisma/enums';

// =============================================================================
// Types
// =============================================================================

export type SupportLevel = 'full' | 'partial';

export type LicenseRecord = {
  id: number;
  name: string;
  url?: string;
  notice?: string;
  poweredBy?: string;
  disableMature?: boolean;
};

export type BaseModelFamilyRecord = {
  id: number;
  name: string;
  description: string;
  sortOrder: number;
};

export type BaseModelGroupRecord = {
  id: number;
  key: string;
  name: string;
  familyId?: number;
  sortOrder: number;
  settings?: Record<string, any>;
  modelVersionId?: number; // Default ModelVersion ID for generation
};

export type EcosystemRecord = {
  id: number;
  name: string;
};

export type BaseModelRecord = {
  id: number;
  name: string;
  type: MediaType;
  hidden?: boolean;
  deprecated?: boolean;
  canGenerate?: boolean;
  canTrain?: boolean;
  canAuction?: boolean;
  ecosystem?: string;
  ecosystemId?: number;
  engine?: string;
  groupId: number;
  licenseId?: number;
};

export type BaseModelGenerationSupportRecord = {
  id: number;
  groupId: number;
  modelType: ModelType;
  baseModelId: number;
  support: SupportLevel;
};

// =============================================================================
// Licenses
// =============================================================================

export const licenses: LicenseRecord[] = [
  {
    id: 1,
    name: 'CreativeML Open RAIL-M',
    url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
  },
  {
    id: 2,
    name: 'SDXL 0.9 research license',
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL0.9',
  },
  {
    id: 3,
    name: 'CreativeML Open RAIL++-M',
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL1.0',
  },
  {
    id: 4,
    name: 'Stability AI Non-Commercial Research Community License',
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDXL-Turbo',
    notice:
      'This Stability AI Model is licensed under the Stability AI Non-Commercial Research Community License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
    disableMature: true,
  },
  {
    id: 5,
    name: 'Stable Video Diffusion Non-Commercial Research Community License',
    url: 'https://github.com/Stability-AI/generative-models/blob/main/model_licenses/LICENSE-SDV',
    notice:
      'Stable Video Diffusion is licensed under the Stable Video Diffusion Research License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
    disableMature: true,
  },
  {
    id: 6,
    name: 'Playground v2 Community License',
    url: 'https://huggingface.co/playgroundai/playground-v2-1024px-aesthetic/blob/main/LICENSE.md',
  },
  {
    id: 7,
    name: 'AGPL-3.0',
    url: 'https://github.com/PixArt-alpha/PixArt-alpha/blob/master/LICENSE',
  },
  {
    id: 8,
    name: 'SAI NC RC',
    url: 'https://huggingface.co/stabilityai/stable-cascade/blob/main/LICENSE',
    notice:
      'This Stability AI Model is licensed under the Stability AI Non-Commercial Research Community License, Copyright (c) Stability AI Ltd. All Rights Reserved.',
    disableMature: true,
  },
  {
    id: 9,
    name: 'Stability AI Community License Agreement',
    notice:
      'This Stability AI Model is licensed under the Stability AI Community License, Copyright (c)  Stability AI Ltd. All Rights Reserved.',
    poweredBy: 'Powered by Stability AI',
    disableMature: true,
  },
  {
    id: 10,
    name: 'Tencent Hunyuan Community License Agreement',
    url: 'https://github.com/Tencent/HunyuanDiT/blob/main/LICENSE.txt',
  },
  {
    id: 11,
    name: 'Tencent Hunyuan Video License Agreement',
    url: 'https://huggingface.co/tencent/HunyuanVideo/blob/main/LICENSE',
    notice:
      'Tencent Hunyuan is licensed under the Tencent Hunyuan Community License Agreement, Copyright © 2024 Tencent. All Rights Reserved. The trademark rights of "Tencent Hunyuan" are owned by Tencent or its affiliate.',
    poweredBy: 'Powered by Tencent Hunyuan',
  },
  {
    id: 12,
    name: 'Kolors License',
    url: 'https://raw.githubusercontent.com/Kwai-Kolors/Kolors/master/MODEL_LICENSE',
  },
  {
    id: 13,
    name: 'Apache 2.0',
    url: 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/apache-2.0.md',
  },
  {
    id: 14,
    name: 'FLUX.1 [dev] Non-Commercial License',
    url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md',
    notice:
      'The FLUX.1 [dev] Model is licensed by Black Forest Labs. Inc. under the FLUX.1 [dev] Non-Commercial License. Copyright Black Forest Labs. Inc.',
    poweredBy:
      'IN NO EVENT SHALL BLACK FOREST LABS, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.',
  },
  {
    id: 15,
    name: 'Illustrious License',
    url: 'https://freedevproject.org/faipl-1.0-sd/',
  },
  {
    id: 16,
    name: 'LTX Video License',
    url: 'https://huggingface.co/Lightricks/LTX-Video/blob/main/License.txt',
  },
  {
    id: 17,
    name: 'CogVideoX License',
    url: 'https://huggingface.co/THUDM/CogVideoX-5b/blob/main/LICENSE',
  },
  {
    id: 18,
    name: 'NoobAI License',
    url: 'https://huggingface.co/Laxhar/noobai-XL-1.0/blob/main/README.md#model-license',
  },
  {
    id: 19,
    name: 'MIT',
    url: 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md',
  },
  {
    id: 20,
    name: 'OpenAI',
    url: 'https://openai.com/policies/',
  },
  {
    id: 21,
    name: 'Imagen4',
    url: 'https://deepmind.google/about/responsibility-safety/',
  },
  {
    id: 22,
    name: 'Veo 3',
    url: 'https://policies.google.com/terms',
  },
  {
    id: 23,
    name: 'Seedream',
    url: 'https://seed.bytedance.com/en/user-agreement',
  },
  {
    id: 24,
    name: 'Pony',
    url: 'https://purplesmart.ai/license',
  },
];

// Helper to get license by ID
export const licenseById = new Map(licenses.map((l) => [l.id, l]));

// =============================================================================
// Ecosystems
// =============================================================================

export const ecosystems: EcosystemRecord[] = [
  { id: 1, name: 'auraflow' },
  { id: 2, name: 'chroma' },
  { id: 3, name: 'cogvideox' },
  { id: 4, name: 'flux1' },
  { id: 5, name: 'flux1kontext' },
  { id: 6, name: 'flux2' },
  { id: 7, name: 'fluxkrea' },
  { id: 8, name: 'hidream' },
  { id: 9, name: 'hydit1' },
  { id: 10, name: 'hyv1' },
  { id: 11, name: 'imagen4' },
  { id: 12, name: 'kolors' },
  { id: 13, name: 'ltxv' },
  { id: 14, name: 'lumina' },
  { id: 15, name: 'mochi' },
  { id: 16, name: 'nanobanana' },
  { id: 17, name: 'odor' },
  { id: 18, name: 'openai' },
  { id: 19, name: 'other' },
  { id: 20, name: 'pixarta' },
  { id: 21, name: 'pixarte' },
  { id: 22, name: 'playgroundv2' },
  { id: 23, name: 'qwen' },
  { id: 24, name: 'scascade' },
  { id: 25, name: 'sd1' },
  { id: 26, name: 'sd2' },
  { id: 27, name: 'sd3' },
  { id: 28, name: 'sdxl' },
  { id: 29, name: 'sdxldistilled' },
  { id: 30, name: 'seedream' },
  { id: 31, name: 'sora2' },
  { id: 32, name: 'svd' },
  { id: 33, name: 'veo3' },
  { id: 34, name: 'wanvideo' },
  { id: 35, name: 'wanvideo-22-i2v-a14b' },
  { id: 36, name: 'wanvideo-22-t2v-a14b' },
  { id: 37, name: 'wanvideo-22-ti2v-5b' },
  { id: 38, name: 'wanvideo-25-i2v' },
  { id: 39, name: 'wanvideo-25-t2v' },
  { id: 40, name: 'wanvideo1_3b_t2v' },
  { id: 41, name: 'wanvideo14b_i2v_480p' },
  { id: 42, name: 'wanvideo14b_i2v_720p' },
  { id: 43, name: 'wanvideo14b_t2v' },
  { id: 44, name: 'zimageturbo' },
];

export const ecosystemById = new Map(ecosystems.map((e) => [e.id, e]));
export const ecosystemByName = new Map(ecosystems.map((e) => [e.name, e]));

// =============================================================================
// Base Model Families
// =============================================================================

export const baseModelFamilies: BaseModelFamilyRecord[] = [
  {
    id: 1,
    name: 'Flux',
    description: "Black Forest Labs' family of state-of-the-art image generation models",
    sortOrder: 0,
  },
  {
    id: 2,
    name: 'Stable Diffusion',
    description: "Stability AI's foundational open-source diffusion models",
    sortOrder: 1,
  },
  {
    id: 3,
    name: 'SDXL Community',
    description: 'Community-trained models built on the SDXL architecture',
    sortOrder: 2,
  },
  {
    id: 4,
    name: 'Hunyuan',
    description: "Tencent's family of image and video generation models",
    sortOrder: 3,
  },
  {
    id: 5,
    name: 'Wan Video',
    description: "Alibaba's video generation model series with various sizes and modes",
    sortOrder: 4,
  },
  {
    id: 6,
    name: 'PixArt',
    description: 'Efficient transformer-based text-to-image models',
    sortOrder: 5,
  },
  {
    id: 7,
    name: 'Google',
    description: "Google's image and video generation models",
    sortOrder: 6,
  },
  {
    id: 8,
    name: 'OpenAI',
    description: "OpenAI's creative image and video generation models",
    sortOrder: 7,
  },
  {
    id: 9,
    name: 'Pony Diffusion',
    description: 'Community models with extensive tag-based prompt support',
    sortOrder: 8,
  },
  {
    id: 10,
    name: 'Qwen',
    description: "Alibaba's multimodal model family with image generation capabilities",
    sortOrder: 9,
  },
  {
    id: 11,
    name: 'ZImageTurbo',
    description: 'Fast turbo-optimized image generation models',
    sortOrder: 10,
  },
  {
    id: 12,
    name: 'ByteDance',
    description: "ByteDance's image and video generation models",
    sortOrder: 11,
  },
];

export const familyById = new Map(baseModelFamilies.map((f) => [f.id, f]));

// =============================================================================
// Common Aspect Ratios
// =============================================================================

const commonAspectRatios = [
  { label: 'Square', width: 1024, height: 1024 },
  { label: 'Landscape', width: 1216, height: 832 },
  { label: 'Portrait', width: 832, height: 1216 },
];

const sd1AspectRatios = [
  { label: 'Square', width: 512, height: 512 },
  { label: 'Landscape', width: 768, height: 512 },
  { label: 'Portrait', width: 512, height: 768 },
];

const seedreamAspectRatios = [
  { label: '16:9', width: 2560, height: 1440 },
  { label: '4:3', width: 2304, height: 1728 },
  { label: '1:1', width: 2048, height: 2048 },
  { label: '3:4', width: 1728, height: 2304 },
  { label: '9:16', width: 1440, height: 2560 },
];

const qwenAspectRatios = [
  { label: '16:9', width: 1664, height: 928 },
  { label: '4:3', width: 1472, height: 1104 },
  { label: '1:1', width: 1328, height: 1328 },
  { label: '3:4', width: 1104, height: 1472 },
  { label: '9:16', width: 928, height: 1664 },
];

const ponyV7AspectRatios = [
  { label: '3:2', width: 1536, height: 1024 },
  { label: '6:5', width: 1536, height: 1280 },
  { label: '1:1', width: 1536, height: 1536 },
  { label: '5:6', width: 1280, height: 1536 },
  { label: '2:3', width: 1024, height: 1536 },
];

const nanoBananaAspectRatios = [
  { label: '16:9', width: 2560, height: 1440 },
  { label: '4:3', width: 2304, height: 1728 },
  { label: '1:1', width: 2048, height: 2048 },
  { label: '3:4', width: 1728, height: 2304 },
  { label: '9:16', width: 1440, height: 2560 },
];

const openAIAspectRatios = [
  { label: 'Square', width: 1024, height: 1024 },
  { label: 'Landscape', width: 1536, height: 1024 },
  { label: 'Portrait', width: 1024, height: 1536 },
];

const imagen4AspectRatios = [
  { label: '16:9', width: 16, height: 9 },
  { label: '4:3', width: 4, height: 3 },
  { label: '1:1', width: 1, height: 1 },
  { label: '3:4', width: 3, height: 4 },
  { label: '9:16', width: 9, height: 16 },
];

const kontextAspectRatios = [
  { label: '21:9', width: 21, height: 9 },
  { label: '16:9', width: 16, height: 9 },
  { label: '4:3', width: 4, height: 3 },
  { label: '3:2', width: 3, height: 2 },
  { label: '1:1', width: 1, height: 1 },
  { label: '2:3', width: 2, height: 3 },
  { label: '3:4', width: 3, height: 4 },
  { label: '9:16', width: 9, height: 16 },
  { label: '9:21', width: 9, height: 21 },
];

// =============================================================================
// Base Model Groups
// =============================================================================

export const baseModelGroups: BaseModelGroupRecord[] = [
  // Flux Family
  {
    id: 1,
    key: 'Flux1',
    name: 'Flux.1',
    familyId: 1,
    sortOrder: 0,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 691639,
  },
  {
    id: 2,
    key: 'FluxKrea',
    name: 'Flux.1 Krea',
    familyId: 1,
    sortOrder: 1,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 2068000,
  },
  {
    id: 3,
    key: 'Flux1Kontext',
    name: 'Flux.1 Kontext',
    familyId: 1,
    sortOrder: 2,
    settings: { aspectRatios: kontextAspectRatios },
    modelVersionId: 1892509,
  },
  {
    id: 4,
    key: 'Flux2',
    name: 'Flux.2',
    familyId: 1,
    sortOrder: 3,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 2439067,
  },

  // Stable Diffusion Family
  {
    id: 5,
    key: 'SD1',
    name: 'Stable Diffusion 1.x',
    familyId: 2,
    sortOrder: 10,
    settings: { aspectRatios: sd1AspectRatios },
    modelVersionId: 128713,
  },
  {
    id: 6,
    key: 'SD2',
    name: 'Stable Diffusion 2.x',
    familyId: 2,
    sortOrder: 11,
  },
  {
    id: 7,
    key: 'SD3',
    name: 'Stable Diffusion 3',
    familyId: 2,
    sortOrder: 12,
    settings: { aspectRatios: commonAspectRatios },
  },
  {
    id: 8,
    key: 'SD3_5M',
    name: 'Stable Diffusion 3.5 Medium',
    familyId: 2,
    sortOrder: 13,
    settings: { aspectRatios: commonAspectRatios },
  },
  {
    id: 9,
    key: 'SDXL',
    name: 'Stable Diffusion XL',
    familyId: 2,
    sortOrder: 14,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 128078,
  },
  {
    id: 10,
    key: 'SDXLDistilled',
    name: 'SDXL Distilled',
    familyId: 2,
    sortOrder: 15,
  },
  {
    id: 11,
    key: 'SCascade',
    name: 'Stable Cascade',
    familyId: 2,
    sortOrder: 16,
  },
  {
    id: 12,
    key: 'SVD',
    name: 'Stable Video Diffusion',
    familyId: 2,
    sortOrder: 17,
  },

  // SDXL Community Family
  {
    id: 13,
    key: 'Illustrious',
    name: 'Illustrious',
    familyId: 3,
    sortOrder: 20,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 889818,
  },
  {
    id: 14,
    key: 'NoobAI',
    name: 'NoobAI',
    familyId: 3,
    sortOrder: 21,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 1190596,
  },

  // Pony Family
  {
    id: 15,
    key: 'Pony',
    name: 'Pony Diffusion',
    familyId: 9,
    sortOrder: 30,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 290640,
  },
  {
    id: 16,
    key: 'PonyV7',
    name: 'Pony Diffusion V7',
    familyId: 9,
    sortOrder: 31,
    settings: { aspectRatios: ponyV7AspectRatios },
    modelVersionId: 2152373,
  },

  // Hunyuan Family
  {
    id: 17,
    key: 'HyDit1',
    name: 'Hunyuan DiT',
    familyId: 4,
    sortOrder: 40,
  },
  {
    id: 18,
    key: 'HyV1',
    name: 'Hunyuan Video',
    familyId: 4,
    sortOrder: 41,
  },

  // WanVideo Family
  {
    id: 19,
    key: 'WanVideo',
    name: 'Wan Video',
    familyId: 5,
    sortOrder: 50,
  },
  {
    id: 20,
    key: 'WanVideo1_3B_T2V',
    name: 'Wan Video 1.3B T2V',
    familyId: 5,
    sortOrder: 51,
  },
  {
    id: 21,
    key: 'WanVideo14B_T2V',
    name: 'Wan Video 14B T2V',
    familyId: 5,
    sortOrder: 52,
  },
  {
    id: 22,
    key: 'WanVideo14B_I2V_480p',
    name: 'Wan Video 14B I2V 480p',
    familyId: 5,
    sortOrder: 53,
  },
  {
    id: 23,
    key: 'WanVideo14B_I2V_720p',
    name: 'Wan Video 14B I2V 720p',
    familyId: 5,
    sortOrder: 54,
  },
  {
    id: 24,
    key: 'WanVideo-22-TI2V-5B',
    name: 'Wan Video 2.2 TI2V 5B',
    familyId: 5,
    sortOrder: 55,
  },
  {
    id: 25,
    key: 'WanVideo-22-I2V-A14B',
    name: 'Wan Video 2.2 I2V A14B',
    familyId: 5,
    sortOrder: 56,
  },
  {
    id: 26,
    key: 'WanVideo-22-T2V-A14B',
    name: 'Wan Video 2.2 T2V A14B',
    familyId: 5,
    sortOrder: 57,
  },
  {
    id: 27,
    key: 'WanVideo-25-T2V',
    name: 'Wan Video 2.5 T2V',
    familyId: 5,
    sortOrder: 58,
  },
  {
    id: 28,
    key: 'WanVideo-25-I2V',
    name: 'Wan Video 2.5 I2V',
    familyId: 5,
    sortOrder: 59,
  },

  // PixArt Family
  {
    id: 29,
    key: 'PixArtA',
    name: 'PixArt Alpha',
    familyId: 6,
    sortOrder: 60,
  },
  {
    id: 30,
    key: 'PixArtE',
    name: 'PixArt Sigma',
    familyId: 6,
    sortOrder: 61,
  },

  // Google Family
  {
    id: 31,
    key: 'Imagen4',
    name: 'Imagen 4',
    familyId: 7,
    sortOrder: 70,
    settings: { aspectRatios: imagen4AspectRatios },
    modelVersionId: 1889632,
  },
  {
    id: 32,
    key: 'NanoBanana',
    name: 'Nano Banana',
    familyId: 7,
    sortOrder: 71,
    settings: { aspectRatios: nanoBananaAspectRatios },
    modelVersionId: 2154472,
  },
  {
    id: 33,
    key: 'Veo3',
    name: 'Veo 3',
    familyId: 7,
    sortOrder: 72,
  },

  // OpenAI Family
  {
    id: 34,
    key: 'OpenAI',
    name: 'OpenAI',
    familyId: 8,
    sortOrder: 80,
    settings: { aspectRatios: openAIAspectRatios },
    modelVersionId: 1733399,
  },
  {
    id: 35,
    key: 'Sora2',
    name: 'Sora 2',
    familyId: 8,
    sortOrder: 81,
  },

  // Qwen Family
  {
    id: 36,
    key: 'Qwen',
    name: 'Qwen',
    familyId: 10,
    sortOrder: 90,
    settings: { aspectRatios: qwenAspectRatios },
    modelVersionId: 2113658,
  },

  // ZImageTurbo Family
  {
    id: 37,
    key: 'ZImageTurbo',
    name: 'ZImageTurbo',
    familyId: 11,
    sortOrder: 100,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 2442439,
  },

  // ByteDance Family
  {
    id: 38,
    key: 'Seedream',
    name: 'Seedream',
    familyId: 12,
    sortOrder: 110,
    settings: { aspectRatios: seedreamAspectRatios },
    modelVersionId: 2208278,
  },

  // Standalone Groups (no family)
  {
    id: 39,
    key: 'AuraFlow',
    name: 'AuraFlow',
    sortOrder: 200,
  },
  {
    id: 40,
    key: 'Chroma',
    name: 'Chroma',
    sortOrder: 201,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 2164239,
  },
  {
    id: 41,
    key: 'CogVideoX',
    name: 'CogVideoX',
    sortOrder: 202,
  },
  {
    id: 42,
    key: 'HiDream',
    name: 'HiDream',
    sortOrder: 203,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 1771369,
  },
  {
    id: 43,
    key: 'Kolors',
    name: 'Kolors',
    sortOrder: 204,
  },
  {
    id: 44,
    key: 'LTXV',
    name: 'LTX Video',
    sortOrder: 205,
  },
  {
    id: 45,
    key: 'Lumina',
    name: 'Lumina',
    sortOrder: 206,
  },
  {
    id: 46,
    key: 'Mochi',
    name: 'Mochi',
    sortOrder: 207,
  },
  {
    id: 47,
    key: 'ODOR',
    name: 'ODOR',
    sortOrder: 208,
  },
  {
    id: 48,
    key: 'PlaygroundV2',
    name: 'Playground v2',
    sortOrder: 209,
  },
  {
    id: 49,
    key: 'Other',
    name: 'Other',
    sortOrder: 999,
    settings: { aspectRatios: commonAspectRatios },
    modelVersionId: 164821,
  },
];

export const groupById = new Map(baseModelGroups.map((g) => [g.id, g]));
export const groupByKey = new Map(baseModelGroups.map((g) => [g.key, g]));

// =============================================================================
// Base Models
// =============================================================================

export const baseModels: BaseModelRecord[] = [
  // AuraFlow
  { id: 1, name: 'AuraFlow', type: 'image', ecosystemId: 1, groupId: 39, licenseId: 13 },

  // Chroma
  {
    id: 2,
    name: 'Chroma',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 2,
    groupId: 40,
    licenseId: 13,
  },

  // CogVideoX
  { id: 3, name: 'CogVideoX', type: 'image', ecosystemId: 3, groupId: 41, licenseId: 17 },

  // Flux.1
  {
    id: 4,
    name: 'Flux.1 S',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 4,
    groupId: 1,
    licenseId: 13,
  },
  {
    id: 5,
    name: 'Flux.1 D',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 4,
    groupId: 1,
    licenseId: 14,
  },
  {
    id: 6,
    name: 'Flux.1 Krea',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 7,
    groupId: 2,
    licenseId: 14,
  },
  {
    id: 7,
    name: 'Flux.1 Kontext',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 5,
    groupId: 3,
    licenseId: 14,
  },
  {
    id: 8,
    name: 'Flux.2 D',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 6,
    groupId: 4,
    licenseId: 14,
  },

  // HiDream
  {
    id: 9,
    name: 'HiDream',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 8,
    groupId: 42,
    licenseId: 19,
  },

  // Hunyuan
  {
    id: 10,
    name: 'Hunyuan 1',
    type: 'image',
    ecosystemId: 9,
    groupId: 17,
    licenseId: 10,
  },
  {
    id: 11,
    name: 'Hunyuan Video',
    type: 'video',
    engine: 'hunyuan',
    ecosystemId: 10,
    groupId: 18,
    licenseId: 11,
  },

  // Illustrious
  {
    id: 12,
    name: 'Illustrious',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystem: 'sdxl',
    ecosystemId: 28,
    groupId: 13,
    licenseId: 15,
  },

  // Imagen4
  {
    id: 13,
    name: 'Imagen4',
    type: 'image',
    hidden: true,
    canGenerate: true,
    canTrain: true,
    ecosystemId: 11,
    groupId: 31,
    licenseId: 21,
  },

  // Kolors
  { id: 14, name: 'Kolors', type: 'image', ecosystemId: 12, groupId: 43, licenseId: 12 },

  // LTXV
  {
    id: 15,
    name: 'LTXV',
    type: 'video',
    engine: 'lightricks',
    ecosystemId: 13,
    groupId: 44,
    licenseId: 16,
  },

  // Lumina
  { id: 16, name: 'Lumina', type: 'image', ecosystemId: 14, groupId: 45, licenseId: 13 },

  // Mochi
  { id: 17, name: 'Mochi', type: 'image', ecosystemId: 15, groupId: 46, licenseId: 13 },

  // Nano Banana
  {
    id: 18,
    name: 'Nano Banana',
    type: 'image',
    hidden: true,
    canGenerate: true,
    canTrain: true,
    ecosystemId: 16,
    groupId: 32,
    licenseId: 21,
  },

  // NoobAI
  {
    id: 19,
    name: 'NoobAI',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystem: 'sdxl',
    ecosystemId: 28,
    groupId: 14,
    licenseId: 18,
  },

  // ODOR
  { id: 20, name: 'ODOR', type: 'image', hidden: true, ecosystemId: 17, groupId: 47 },

  // OpenAI
  {
    id: 21,
    name: 'OpenAI',
    type: 'image',
    hidden: true,
    canGenerate: true,
    canTrain: true,
    ecosystemId: 18,
    groupId: 34,
    licenseId: 20,
  },

  // Other
  {
    id: 22,
    name: 'Other',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 19,
    groupId: 49,
  },

  // PixArt
  {
    id: 23,
    name: 'PixArt a',
    type: 'image',
    ecosystemId: 20,
    groupId: 29,
    licenseId: 3,
  },
  {
    id: 24,
    name: 'PixArt E',
    type: 'image',
    ecosystemId: 21,
    groupId: 30,
    licenseId: 3,
  },

  // Playground v2
  {
    id: 25,
    name: 'Playground v2',
    type: 'image',
    hidden: true,
    ecosystemId: 22,
    groupId: 48,
    licenseId: 6,
  },

  // Pony
  {
    id: 26,
    name: 'Pony',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystem: 'sdxl',
    ecosystemId: 28,
    groupId: 15,
    licenseId: 3,
  },
  {
    id: 27,
    name: 'Pony V7',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystem: 'auraflow',
    ecosystemId: 1,
    groupId: 16,
    licenseId: 24,
  },

  // Qwen
  {
    id: 28,
    name: 'Qwen',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystem: 'qwen',
    ecosystemId: 23,
    groupId: 36,
    licenseId: 13,
  },

  // Stable Cascade
  {
    id: 29,
    name: 'Stable Cascade',
    type: 'image',
    hidden: true,
    ecosystemId: 24,
    groupId: 11,
    licenseId: 8,
  },

  // SD 1.x
  {
    id: 30,
    name: 'SD 1.4',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 25,
    groupId: 5,
    licenseId: 1,
  },
  {
    id: 31,
    name: 'SD 1.5',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 25,
    groupId: 5,
    licenseId: 1,
  },
  {
    id: 32,
    name: 'SD 1.5 LCM',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 25,
    groupId: 5,
    licenseId: 3,
  },
  {
    id: 33,
    name: 'SD 1.5 Hyper',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 25,
    groupId: 5,
    licenseId: 3,
  },

  // SD 2.x
  { id: 34, name: 'SD 2.0', type: 'image', ecosystemId: 26, groupId: 6, licenseId: 1 },
  {
    id: 35,
    name: 'SD 2.0 768',
    type: 'image',
    hidden: true,
    ecosystemId: 26,
    groupId: 6,
    licenseId: 1,
  },
  { id: 36, name: 'SD 2.1', type: 'image', ecosystemId: 26, groupId: 6, licenseId: 1 },
  {
    id: 37,
    name: 'SD 2.1 768',
    type: 'image',
    hidden: true,
    ecosystemId: 26,
    groupId: 6,
    licenseId: 1,
  },
  {
    id: 38,
    name: 'SD 2.1 Unclip',
    type: 'image',
    hidden: true,
    ecosystemId: 26,
    groupId: 6,
    licenseId: 1,
  },

  // SD 3.x
  {
    id: 39,
    name: 'SD 3',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystemId: 27,
    groupId: 7,
    licenseId: 9,
  },
  {
    id: 40,
    name: 'SD 3.5',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystemId: 27,
    groupId: 7,
    licenseId: 9,
  },
  {
    id: 41,
    name: 'SD 3.5 Large',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystemId: 27,
    groupId: 7,
    licenseId: 9,
  },
  {
    id: 42,
    name: 'SD 3.5 Large Turbo',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystemId: 27,
    groupId: 7,
    licenseId: 9,
  },
  {
    id: 43,
    name: 'SD 3.5 Medium',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystem: 'sd3',
    ecosystemId: 27,
    groupId: 8,
    licenseId: 9,
  },

  // SDXL
  {
    id: 44,
    name: 'SDXL 0.9',
    type: 'image',
    hidden: true,
    ecosystemId: 28,
    groupId: 9,
    licenseId: 2,
  },
  {
    id: 45,
    name: 'SDXL 1.0',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 28,
    groupId: 9,
    licenseId: 3,
  },
  {
    id: 46,
    name: 'SDXL 1.0 LCM',
    type: 'image',
    hidden: true,
    canGenerate: true,
    canTrain: true,
    ecosystemId: 28,
    groupId: 9,
    licenseId: 3,
  },
  {
    id: 47,
    name: 'SDXL Lightning',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 28,
    groupId: 9,
    licenseId: 3,
  },
  {
    id: 48,
    name: 'SDXL Hyper',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystemId: 28,
    groupId: 9,
    licenseId: 3,
  },
  {
    id: 49,
    name: 'SDXL Turbo',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystemId: 28,
    groupId: 9,
    licenseId: 4,
  },
  {
    id: 50,
    name: 'SDXL Distilled',
    type: 'image',
    hidden: true,
    ecosystemId: 29,
    groupId: 10,
    licenseId: 3,
  },

  // Seedream
  {
    id: 51,
    name: 'Seedream',
    type: 'image',
    hidden: true,
    canGenerate: true,
    canTrain: true,
    ecosystemId: 30,
    groupId: 38,
    licenseId: 23,
  },

  // SVD
  {
    id: 52,
    name: 'SVD',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystemId: 32,
    groupId: 12,
    licenseId: 5,
  },
  {
    id: 53,
    name: 'SVD XT',
    type: 'image',
    hidden: true,
    deprecated: true,
    ecosystemId: 32,
    groupId: 12,
    licenseId: 5,
  },

  // Sora 2
  {
    id: 54,
    name: 'Sora 2',
    type: 'video',
    hidden: true,
    ecosystemId: 31,
    groupId: 35,
    licenseId: 20,
  },

  // Veo 3
  {
    id: 55,
    name: 'Veo 3',
    type: 'video',
    hidden: true,
    engine: 'veo3',
    ecosystemId: 33,
    groupId: 33,
    licenseId: 22,
  },

  // Wan Video
  {
    id: 56,
    name: 'Wan Video',
    type: 'video',
    hidden: true,
    engine: 'wan',
    ecosystemId: 34,
    groupId: 19,
    licenseId: 13,
  },
  {
    id: 57,
    name: 'Wan Video 1.3B t2v',
    type: 'video',
    engine: 'wan',
    ecosystemId: 40,
    groupId: 20,
    licenseId: 13,
  },
  {
    id: 58,
    name: 'Wan Video 14B t2v',
    type: 'video',
    engine: 'wan',
    ecosystemId: 43,
    groupId: 21,
    licenseId: 13,
  },
  {
    id: 59,
    name: 'Wan Video 14B i2v 480p',
    type: 'video',
    engine: 'wan',
    ecosystemId: 41,
    groupId: 22,
    licenseId: 13,
  },
  {
    id: 60,
    name: 'Wan Video 14B i2v 720p',
    type: 'video',
    engine: 'wan',
    ecosystemId: 42,
    groupId: 23,
    licenseId: 13,
  },
  {
    id: 61,
    name: 'Wan Video 2.2 TI2V-5B',
    type: 'video',
    engine: 'wan',
    ecosystemId: 37,
    groupId: 24,
    licenseId: 13,
  },
  {
    id: 62,
    name: 'Wan Video 2.2 I2V-A14B',
    type: 'video',
    engine: 'wan',
    ecosystemId: 35,
    groupId: 25,
    licenseId: 13,
  },
  {
    id: 63,
    name: 'Wan Video 2.2 T2V-A14B',
    type: 'video',
    engine: 'wan',
    ecosystemId: 36,
    groupId: 26,
    licenseId: 13,
  },
  {
    id: 64,
    name: 'Wan Video 2.5 T2V',
    type: 'video',
    engine: 'wan',
    ecosystemId: 39,
    groupId: 27,
    licenseId: 13,
  },
  {
    id: 65,
    name: 'Wan Video 2.5 I2V',
    type: 'video',
    engine: 'wan',
    ecosystemId: 38,
    groupId: 28,
    licenseId: 13,
  },

  // ZImageTurbo
  {
    id: 66,
    name: 'ZImageTurbo',
    type: 'image',
    canGenerate: true,
    canTrain: true,
    ecosystem: 'zimageturbo',
    ecosystemId: 44,
    groupId: 37,
    licenseId: 13,
  },
];

export const baseModelById = new Map(baseModels.map((m) => [m.id, m]));
export const baseModelByName = new Map(baseModels.map((m) => [m.name, m]));

// =============================================================================
// Generation Support Matrix
// =============================================================================

// Counter for auto-incrementing generation support IDs
let gsIdCounter = 0;

// Helper to create support records with numeric IDs
function createSupport(
  groupId: number,
  modelType: ModelType,
  baseModelId: number,
  support: SupportLevel
): BaseModelGenerationSupportRecord {
  return {
    id: ++gsIdCounter,
    groupId,
    modelType,
    baseModelId,
    support,
  };
}

// Full model type sets for convenience
const allStandardModelTypes = [
  ModelType.Checkpoint,
  ModelType.TextualInversion,
  ModelType.LORA,
  ModelType.DoRA,
  ModelType.LoCon,
  ModelType.VAE,
];

const checkpointAndLora = [ModelType.Checkpoint, ModelType.LORA];

// Base model ID constants for readability
const BM = {
  SD14: 30,
  SD15: 31,
  SD15LCM: 32,
  SD15Hyper: 33,
  SDXL09: 44,
  SDXL10: 45,
  SDXL10LCM: 46,
  SDXLLightning: 47,
  SDXLHyper: 48,
  SDXLTurbo: 49,
  Pony: 26,
  PonyV7: 27,
  Illustrious: 12,
  Chroma: 2,
  NoobAI: 19,
  Flux1S: 4,
  Flux1D: 5,
  Flux1Krea: 6,
  Flux1Kontext: 7,
  Flux2D: 8,
  HiDream: 9,
  HunyuanVideo: 11,
  Imagen4: 13,
  OpenAI: 21,
  NanoBanana: 18,
  Qwen: 28,
  Seedream: 51,
  Sora2: 54,
  Veo3: 55,
  ZImageTurbo: 66,
  WanVideo: 56,
  WanVideo14BT2V: 58,
  WanVideo14BI2V480p: 59,
  WanVideo14BI2V720p: 60,
  WanVideo22T2VA14B: 63,
  WanVideo22I2VA14B: 62,
  WanVideo22TI2V5B: 61,
  WanVideo25T2V: 64,
  WanVideo25I2V: 65,
};

// Group ID constants for readability
const GRP = {
  Flux1: 1,
  FluxKrea: 2,
  Flux1Kontext: 3,
  Flux2: 4,
  SD1: 5,
  SD2: 6,
  SD3: 7,
  SD35M: 8,
  SDXL: 9,
  SDXLDistilled: 10,
  SCascade: 11,
  SVD: 12,
  Illustrious: 13,
  NoobAI: 14,
  Pony: 15,
  PonyV7: 16,
  HyDit1: 17,
  HyV1: 18,
  WanVideo: 19,
  WanVideo1_3BT2V: 20,
  WanVideo14BT2V: 21,
  WanVideo14BI2V480p: 22,
  WanVideo14BI2V720p: 23,
  WanVideo22TI2V5B: 24,
  WanVideo22I2VA14B: 25,
  WanVideo22T2VA14B: 26,
  WanVideo25T2V: 27,
  WanVideo25I2V: 28,
  PixArtA: 29,
  PixArtE: 30,
  Imagen4: 31,
  NanoBanana: 32,
  Veo3: 33,
  OpenAI: 34,
  Sora2: 35,
  Qwen: 36,
  ZImageTurbo: 37,
  Seedream: 38,
  AuraFlow: 39,
  Chroma: 40,
  CogVideoX: 41,
  HiDream: 42,
  Kolors: 43,
  LTXV: 44,
  Lumina: 45,
  Mochi: 46,
  ODOR: 47,
  PlaygroundV2: 48,
  Other: 49,
};

export const generationSupport: BaseModelGenerationSupportRecord[] = [
  // SD1 Group - full support for all SD1 base models
  ...allStandardModelTypes.flatMap((mt) => [
    createSupport(GRP.SD1, mt, BM.SD14, 'full'),
    createSupport(GRP.SD1, mt, BM.SD15, 'full'),
    createSupport(GRP.SD1, mt, BM.SD15LCM, 'full'),
    createSupport(GRP.SD1, mt, BM.SD15Hyper, 'full'),
  ]),

  // SDXL Group - full support for SDXL base models
  ...allStandardModelTypes.flatMap((mt) => [
    createSupport(GRP.SDXL, mt, BM.SDXL09, 'full'),
    createSupport(GRP.SDXL, mt, BM.SDXL10, 'full'),
    createSupport(GRP.SDXL, mt, BM.SDXL10LCM, 'full'),
    createSupport(GRP.SDXL, mt, BM.SDXLLightning, 'full'),
    createSupport(GRP.SDXL, mt, BM.SDXLHyper, 'full'),
    createSupport(GRP.SDXL, mt, BM.SDXLTurbo, 'full'),
  ]),
  // SDXL partial support
  createSupport(GRP.SDXL, ModelType.TextualInversion, BM.SD15, 'partial'),
  createSupport(GRP.SDXL, ModelType.TextualInversion, BM.Pony, 'partial'),
  createSupport(GRP.SDXL, ModelType.TextualInversion, BM.Illustrious, 'partial'),
  createSupport(GRP.SDXL, ModelType.TextualInversion, BM.NoobAI, 'partial'),
  createSupport(GRP.SDXL, ModelType.LORA, BM.Pony, 'partial'),
  createSupport(GRP.SDXL, ModelType.LORA, BM.Illustrious, 'partial'),
  createSupport(GRP.SDXL, ModelType.LORA, BM.NoobAI, 'partial'),
  createSupport(GRP.SDXL, ModelType.DoRA, BM.Pony, 'partial'),
  createSupport(GRP.SDXL, ModelType.DoRA, BM.Illustrious, 'partial'),
  createSupport(GRP.SDXL, ModelType.DoRA, BM.NoobAI, 'partial'),
  createSupport(GRP.SDXL, ModelType.LoCon, BM.Pony, 'partial'),
  createSupport(GRP.SDXL, ModelType.LoCon, BM.Illustrious, 'partial'),
  createSupport(GRP.SDXL, ModelType.LoCon, BM.NoobAI, 'partial'),
  createSupport(GRP.SDXL, ModelType.VAE, BM.Pony, 'partial'),
  createSupport(GRP.SDXL, ModelType.VAE, BM.Illustrious, 'partial'),
  createSupport(GRP.SDXL, ModelType.VAE, BM.NoobAI, 'partial'),

  // Pony Group
  ...allStandardModelTypes.map((mt) => createSupport(GRP.Pony, mt, BM.Pony, 'full')),
  // Pony partial support
  createSupport(GRP.Pony, ModelType.TextualInversion, BM.SD15, 'partial'),
  createSupport(GRP.Pony, ModelType.TextualInversion, BM.SDXL09, 'partial'),
  createSupport(GRP.Pony, ModelType.TextualInversion, BM.SDXL10, 'partial'),
  createSupport(GRP.Pony, ModelType.TextualInversion, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Pony, ModelType.TextualInversion, BM.Illustrious, 'partial'),
  createSupport(GRP.Pony, ModelType.TextualInversion, BM.NoobAI, 'partial'),
  createSupport(GRP.Pony, ModelType.LORA, BM.SDXL09, 'partial'),
  createSupport(GRP.Pony, ModelType.LORA, BM.SDXL10, 'partial'),
  createSupport(GRP.Pony, ModelType.LORA, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Pony, ModelType.LORA, BM.Illustrious, 'partial'),
  createSupport(GRP.Pony, ModelType.LORA, BM.NoobAI, 'partial'),
  createSupport(GRP.Pony, ModelType.DoRA, BM.SDXL09, 'partial'),
  createSupport(GRP.Pony, ModelType.DoRA, BM.SDXL10, 'partial'),
  createSupport(GRP.Pony, ModelType.DoRA, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Pony, ModelType.DoRA, BM.Illustrious, 'partial'),
  createSupport(GRP.Pony, ModelType.DoRA, BM.NoobAI, 'partial'),
  createSupport(GRP.Pony, ModelType.LoCon, BM.SDXL09, 'partial'),
  createSupport(GRP.Pony, ModelType.LoCon, BM.SDXL10, 'partial'),
  createSupport(GRP.Pony, ModelType.LoCon, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Pony, ModelType.LoCon, BM.Illustrious, 'partial'),
  createSupport(GRP.Pony, ModelType.LoCon, BM.NoobAI, 'partial'),
  createSupport(GRP.Pony, ModelType.VAE, BM.SDXL09, 'partial'),
  createSupport(GRP.Pony, ModelType.VAE, BM.SDXL10, 'partial'),
  createSupport(GRP.Pony, ModelType.VAE, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Pony, ModelType.VAE, BM.SDXLLightning, 'partial'),
  createSupport(GRP.Pony, ModelType.VAE, BM.SDXLHyper, 'partial'),
  createSupport(GRP.Pony, ModelType.VAE, BM.SDXLTurbo, 'partial'),

  // PonyV7 Group
  ...checkpointAndLora.map((mt) => createSupport(GRP.PonyV7, mt, BM.PonyV7, 'full')),

  // Illustrious Group
  ...allStandardModelTypes.map((mt) => createSupport(GRP.Illustrious, mt, BM.Illustrious, 'full')),
  // Illustrious partial support (same as Pony)
  createSupport(GRP.Illustrious, ModelType.TextualInversion, BM.SD15, 'partial'),
  createSupport(GRP.Illustrious, ModelType.TextualInversion, BM.SDXL09, 'partial'),
  createSupport(GRP.Illustrious, ModelType.TextualInversion, BM.SDXL10, 'partial'),
  createSupport(GRP.Illustrious, ModelType.TextualInversion, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Illustrious, ModelType.TextualInversion, BM.Pony, 'partial'),
  createSupport(GRP.Illustrious, ModelType.TextualInversion, BM.NoobAI, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LORA, BM.SDXL09, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LORA, BM.SDXL10, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LORA, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LORA, BM.Pony, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LORA, BM.NoobAI, 'partial'),
  createSupport(GRP.Illustrious, ModelType.DoRA, BM.SDXL09, 'partial'),
  createSupport(GRP.Illustrious, ModelType.DoRA, BM.SDXL10, 'partial'),
  createSupport(GRP.Illustrious, ModelType.DoRA, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Illustrious, ModelType.DoRA, BM.Pony, 'partial'),
  createSupport(GRP.Illustrious, ModelType.DoRA, BM.NoobAI, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LoCon, BM.SDXL09, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LoCon, BM.SDXL10, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LoCon, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LoCon, BM.Pony, 'partial'),
  createSupport(GRP.Illustrious, ModelType.LoCon, BM.NoobAI, 'partial'),
  createSupport(GRP.Illustrious, ModelType.VAE, BM.SDXL09, 'partial'),
  createSupport(GRP.Illustrious, ModelType.VAE, BM.SDXL10, 'partial'),
  createSupport(GRP.Illustrious, ModelType.VAE, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.Illustrious, ModelType.VAE, BM.SDXLLightning, 'partial'),
  createSupport(GRP.Illustrious, ModelType.VAE, BM.SDXLHyper, 'partial'),
  createSupport(GRP.Illustrious, ModelType.VAE, BM.SDXLTurbo, 'partial'),

  // Chroma Group
  ...allStandardModelTypes.map((mt) => createSupport(GRP.Chroma, mt, BM.Chroma, 'full')),

  // NoobAI Group
  ...allStandardModelTypes.map((mt) => createSupport(GRP.NoobAI, mt, BM.NoobAI, 'full')),
  // NoobAI partial support (same as Illustrious)
  createSupport(GRP.NoobAI, ModelType.TextualInversion, BM.SD15, 'partial'),
  createSupport(GRP.NoobAI, ModelType.TextualInversion, BM.SDXL09, 'partial'),
  createSupport(GRP.NoobAI, ModelType.TextualInversion, BM.SDXL10, 'partial'),
  createSupport(GRP.NoobAI, ModelType.TextualInversion, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.NoobAI, ModelType.TextualInversion, BM.Pony, 'partial'),
  createSupport(GRP.NoobAI, ModelType.TextualInversion, BM.Illustrious, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LORA, BM.SDXL09, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LORA, BM.SDXL10, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LORA, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LORA, BM.Pony, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LORA, BM.Illustrious, 'partial'),
  createSupport(GRP.NoobAI, ModelType.DoRA, BM.SDXL09, 'partial'),
  createSupport(GRP.NoobAI, ModelType.DoRA, BM.SDXL10, 'partial'),
  createSupport(GRP.NoobAI, ModelType.DoRA, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.NoobAI, ModelType.DoRA, BM.Pony, 'partial'),
  createSupport(GRP.NoobAI, ModelType.DoRA, BM.Illustrious, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LoCon, BM.SDXL09, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LoCon, BM.SDXL10, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LoCon, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LoCon, BM.Pony, 'partial'),
  createSupport(GRP.NoobAI, ModelType.LoCon, BM.Illustrious, 'partial'),
  createSupport(GRP.NoobAI, ModelType.VAE, BM.SDXL09, 'partial'),
  createSupport(GRP.NoobAI, ModelType.VAE, BM.SDXL10, 'partial'),
  createSupport(GRP.NoobAI, ModelType.VAE, BM.SDXL10LCM, 'partial'),
  createSupport(GRP.NoobAI, ModelType.VAE, BM.SDXLLightning, 'partial'),
  createSupport(GRP.NoobAI, ModelType.VAE, BM.SDXLHyper, 'partial'),
  createSupport(GRP.NoobAI, ModelType.VAE, BM.SDXLTurbo, 'partial'),

  // Flux1 Group
  ...checkpointAndLora.flatMap((mt) => [
    createSupport(GRP.Flux1, mt, BM.Flux1S, 'full'),
    createSupport(GRP.Flux1, mt, BM.Flux1D, 'full'),
  ]),
  createSupport(GRP.Flux1, ModelType.LORA, BM.Flux1Krea, 'partial'),

  // FluxKrea Group
  ...checkpointAndLora.map((mt) => createSupport(GRP.FluxKrea, mt, BM.Flux1Krea, 'full')),
  createSupport(GRP.FluxKrea, ModelType.LORA, BM.Flux1D, 'partial'),

  // Flux1Kontext Group
  createSupport(GRP.Flux1Kontext, ModelType.Checkpoint, BM.Flux1Kontext, 'full'),

  // Flux2 Group
  ...checkpointAndLora.map((mt) => createSupport(GRP.Flux2, mt, BM.Flux2D, 'full')),

  // HiDream Group
  ...checkpointAndLora.map((mt) => createSupport(GRP.HiDream, mt, BM.HiDream, 'full')),

  // HyV1 Group
  createSupport(GRP.HyV1, ModelType.LORA, BM.HunyuanVideo, 'full'),

  // Imagen4 Group
  createSupport(GRP.Imagen4, ModelType.Checkpoint, BM.Imagen4, 'full'),

  // OpenAI Group
  createSupport(GRP.OpenAI, ModelType.Checkpoint, BM.OpenAI, 'full'),

  // NanoBanana Group
  createSupport(GRP.NanoBanana, ModelType.Checkpoint, BM.NanoBanana, 'full'),

  // Qwen Group
  ...checkpointAndLora.map((mt) => createSupport(GRP.Qwen, mt, BM.Qwen, 'full')),

  // Seedream Group
  createSupport(GRP.Seedream, ModelType.Checkpoint, BM.Seedream, 'full'),

  // Sora2 Group
  createSupport(GRP.Sora2, ModelType.Checkpoint, BM.Sora2, 'full'),

  // Veo3 Group
  createSupport(GRP.Veo3, ModelType.Checkpoint, BM.Veo3, 'full'),

  // ZImageTurbo Group
  ...checkpointAndLora.map((mt) => createSupport(GRP.ZImageTurbo, mt, BM.ZImageTurbo, 'full')),

  // WanVideo Groups
  createSupport(GRP.WanVideo, ModelType.LORA, BM.WanVideo, 'full'),

  // WanVideo14B_T2V
  ...checkpointAndLora.map((mt) =>
    createSupport(GRP.WanVideo14BT2V, mt, BM.WanVideo14BT2V, 'full')
  ),
  createSupport(GRP.WanVideo14BT2V, ModelType.LORA, BM.WanVideo22T2VA14B, 'partial'),
  createSupport(GRP.WanVideo14BT2V, ModelType.LORA, BM.WanVideo22I2VA14B, 'partial'),
  createSupport(GRP.WanVideo14BT2V, ModelType.LORA, BM.WanVideo22TI2V5B, 'partial'),

  // WanVideo14B_I2V_480p
  ...checkpointAndLora.map((mt) =>
    createSupport(GRP.WanVideo14BI2V480p, mt, BM.WanVideo14BI2V480p, 'full')
  ),
  createSupport(GRP.WanVideo14BI2V480p, ModelType.LORA, BM.WanVideo14BI2V720p, 'full'),
  createSupport(GRP.WanVideo14BI2V480p, ModelType.LORA, BM.WanVideo22T2VA14B, 'partial'),
  createSupport(GRP.WanVideo14BI2V480p, ModelType.LORA, BM.WanVideo22I2VA14B, 'partial'),
  createSupport(GRP.WanVideo14BI2V480p, ModelType.LORA, BM.WanVideo22TI2V5B, 'partial'),

  // WanVideo14B_I2V_720p
  ...checkpointAndLora.map((mt) =>
    createSupport(GRP.WanVideo14BI2V720p, mt, BM.WanVideo14BI2V720p, 'full')
  ),
  createSupport(GRP.WanVideo14BI2V720p, ModelType.LORA, BM.WanVideo14BI2V480p, 'partial'),
  createSupport(GRP.WanVideo14BI2V720p, ModelType.LORA, BM.WanVideo22T2VA14B, 'partial'),
  createSupport(GRP.WanVideo14BI2V720p, ModelType.LORA, BM.WanVideo22I2VA14B, 'partial'),
  createSupport(GRP.WanVideo14BI2V720p, ModelType.LORA, BM.WanVideo22TI2V5B, 'partial'),

  // WanVideo22_T2V_A14B
  ...checkpointAndLora.map((mt) =>
    createSupport(GRP.WanVideo22T2VA14B, mt, BM.WanVideo22T2VA14B, 'full')
  ),
  createSupport(GRP.WanVideo22T2VA14B, ModelType.LORA, BM.WanVideo14BT2V, 'partial'),
  createSupport(GRP.WanVideo22T2VA14B, ModelType.LORA, BM.WanVideo14BI2V480p, 'partial'),
  createSupport(GRP.WanVideo22T2VA14B, ModelType.LORA, BM.WanVideo14BI2V720p, 'partial'),

  // WanVideo22_I2V_A14B
  ...checkpointAndLora.map((mt) =>
    createSupport(GRP.WanVideo22I2VA14B, mt, BM.WanVideo22I2VA14B, 'full')
  ),
  createSupport(GRP.WanVideo22I2VA14B, ModelType.LORA, BM.WanVideo14BT2V, 'partial'),
  createSupport(GRP.WanVideo22I2VA14B, ModelType.LORA, BM.WanVideo14BI2V480p, 'partial'),
  createSupport(GRP.WanVideo22I2VA14B, ModelType.LORA, BM.WanVideo14BI2V720p, 'partial'),

  // WanVideo22_TI2V_5B
  ...checkpointAndLora.map((mt) =>
    createSupport(GRP.WanVideo22TI2V5B, mt, BM.WanVideo22TI2V5B, 'full')
  ),
  createSupport(GRP.WanVideo22TI2V5B, ModelType.LORA, BM.WanVideo14BT2V, 'partial'),
  createSupport(GRP.WanVideo22TI2V5B, ModelType.LORA, BM.WanVideo14BI2V480p, 'partial'),
  createSupport(GRP.WanVideo22TI2V5B, ModelType.LORA, BM.WanVideo14BI2V720p, 'partial'),

  // WanVideo25_T2V
  createSupport(GRP.WanVideo25T2V, ModelType.Checkpoint, BM.WanVideo25T2V, 'full'),

  // WanVideo25_I2V
  createSupport(GRP.WanVideo25I2V, ModelType.Checkpoint, BM.WanVideo25I2V, 'full'),
];

export const generationSupportById = new Map(generationSupport.map((s) => [s.id, s]));

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get all base models for a given group
 */
export function getBaseModelsByGroupId(groupId: number): BaseModelRecord[] {
  return baseModels.filter((m) => m.groupId === groupId);
}

/**
 * Get generation support for a group and model type
 */
export function getGenerationSupportForGroup(
  groupId: number,
  modelType?: ModelType
): BaseModelGenerationSupportRecord[] {
  return generationSupport.filter(
    (s) => s.groupId === groupId && (modelType === undefined || s.modelType === modelType)
  );
}

/**
 * Get compatible base models for generation
 */
export function getCompatibleBaseModels(
  groupId: number,
  modelType: ModelType
): { full: BaseModelRecord[]; partial: BaseModelRecord[] } {
  const support = getGenerationSupportForGroup(groupId, modelType);

  const full = support
    .filter((s) => s.support === 'full')
    .map((s) => baseModelById.get(s.baseModelId))
    .filter((m): m is BaseModelRecord => m !== undefined);

  const partial = support
    .filter((s) => s.support === 'partial')
    .map((s) => baseModelById.get(s.baseModelId))
    .filter((m): m is BaseModelRecord => m !== undefined);

  return { full, partial };
}

/**
 * Get license for a base model
 */
export function getBaseModelLicense(baseModelId: number): LicenseRecord | undefined {
  const model = baseModelById.get(baseModelId);
  if (!model?.licenseId) return undefined;
  return licenseById.get(model.licenseId);
}

/**
 * Get family for a group
 */
export function getGroupFamily(groupId: number): BaseModelFamilyRecord | undefined {
  const group = groupById.get(groupId);
  if (!group?.familyId) return undefined;
  return familyById.get(group.familyId);
}

/**
 * Get all groups for a family
 */
export function getGroupsByFamilyId(familyId: number): BaseModelGroupRecord[] {
  return baseModelGroups.filter((g) => g.familyId === familyId);
}

/**
 * Get base models available for generation
 */
export function getGenerationBaseModels(): BaseModelRecord[] {
  return baseModels.filter((m) => m.canGenerate && !m.hidden && !m.deprecated);
}

/**
 * Get base models available for auction
 */
export function getAuctionBaseModels(): BaseModelRecord[] {
  return baseModels.filter((m) => m.canAuction && !m.hidden && !m.deprecated);
}

/**
 * Get deprecated base models
 */
export function getDeprecatedBaseModels(): BaseModelRecord[] {
  return baseModels.filter((m) => m.deprecated);
}

/**
 * Get the default model version ID for a base model group.
 * @param groupKey The group key (e.g., 'SD1', 'SDXL', 'Flux1')
 * @returns The default modelVersionId or undefined if not found
 */
export function getGroupDefaultModelVersionId(groupKey: string): number | undefined {
  return groupByKey.get(groupKey)?.modelVersionId;
}

/**
 * Get a base model group by its key.
 * @param groupKey The group key (e.g., 'SD1', 'SDXL', 'Flux1')
 * @returns The group record or undefined if not found
 */
export function getBaseModelGroupByKey(groupKey: string): BaseModelGroupRecord | undefined {
  return groupByKey.get(groupKey);
}

/**
 * Get the ecosystem for a base model.
 * @param baseModelId The ID of the base model
 * @returns The ecosystem record or undefined if not found
 */
export function getBaseModelEcosystem(baseModelId: number): EcosystemRecord | undefined {
  const model = baseModelById.get(baseModelId);
  if (!model?.ecosystemId) return undefined;
  return ecosystemById.get(model.ecosystemId);
}

/**
 * Get all base models belonging to a specific ecosystem.
 * @param ecosystemId The ID of the ecosystem
 * @returns Array of base models in that ecosystem
 */
export function getBaseModelsByEcosystemId(ecosystemId: number): BaseModelRecord[] {
  return baseModels.filter((m) => m.ecosystemId === ecosystemId);
}

/**
 * Get all base models belonging to a specific ecosystem by name.
 * @param ecosystemName The name of the ecosystem (e.g., 'sdxl', 'flux1')
 * @returns Array of base models in that ecosystem
 */
export function getBaseModelsByEcosystemName(ecosystemName: string): BaseModelRecord[] {
  const ecosystem = ecosystemByName.get(ecosystemName);
  if (!ecosystem) return [];
  return getBaseModelsByEcosystemId(ecosystem.id);
}

/**
 * Result for a single base model's compatibility check
 */
export type BaseModelCompatibilityStatus = {
  baseModel: string;
  support: SupportLevel | null; // null means not compatible
};

/**
 * A group that supports one or more of the requested base models
 */
export type CompatibleGroupResult = {
  groupId: number;
  groupName: string;
  groupKey: string;
  baseModels: BaseModelCompatibilityStatus[];
};

/**
 * Result of checking base model compatibility for generation
 */
export type GenerationCompatibilityResult = {
  /** The primary base model used to determine the generation group */
  primaryBaseModel: string;
  /** The group determined by the primary base model */
  primaryGroup: { id: number; name: string; key: string } | null;
  /** Whether all requested base models are compatible with the primary group */
  allCompatible: boolean;
  /** Compatibility status for each requested base model within the primary group */
  compatibility: BaseModelCompatibilityStatus[];
  /** List of incompatible base models (those with null support) */
  incompatible: string[];
  /** Alternative groups that support one or more of the incompatible base models */
  alternativeGroups: CompatibleGroupResult[];
};

/**
 * Check generation compatibility for a set of base models against a primary base model or group.
 *
 * Given a primary base model or group key (e.g., the checkpoint being used for generation) and a list
 * of additional base models (e.g., LoRAs, embeddings), this function determines:
 * - Which base models are compatible with the primary model's generation group
 * - Which are incompatible
 * - What alternative groups could support the incompatible base models
 *
 * @param baseModelOrGroup - The key of the primary base model (e.g., "SDXL 1.0") or group (e.g., "SDXL")
 * @param baseModelKeys - Array of base model keys to check compatibility for
 * @returns Compatibility result with status for each base model and alternative groups
 *
 * @example
 * ```ts
 * // Using a base model key
 * const result = checkGenerationCompatibility('SDXL 1.0', ['Pony', 'SD 1.5', 'Flux.1 D']);
 *
 * // Using a group key
 * const result = checkGenerationCompatibility('SDXL', ['Pony', 'SD 1.5', 'Flux.1 D']);
 *
 * // result.allCompatible = false
 * // result.compatibility = [
 * //   { baseModel: 'Pony', support: 'partial' },
 * //   { baseModel: 'SD 1.5', support: null },
 * //   { baseModel: 'Flux.1 D', support: null }
 * // ]
 * // result.incompatible = ['SD 1.5', 'Flux.1 D']
 * // result.alternativeGroups = [groups that support SD 1.5 or Flux.1 D]
 * ```
 */
export function checkGenerationCompatibility(
  baseModelOrGroup: string,
  baseModelKeys: string[]
): GenerationCompatibilityResult {
  // Try to find as a base model first, then as a group
  const primaryAsBaseModel = baseModelByName.get(baseModelOrGroup);
  const primaryAsGroup = groupByKey.get(baseModelOrGroup);

  let primaryGroup: BaseModelGroupRecord | undefined;

  if (primaryAsBaseModel) {
    // Found as a base model, get its group
    primaryGroup = groupById.get(primaryAsBaseModel.groupId);
  } else if (primaryAsGroup) {
    // Found as a group directly
    primaryGroup = primaryAsGroup;
  }

  if (!primaryGroup) {
    return {
      primaryBaseModel: baseModelOrGroup,
      primaryGroup: null,
      allCompatible: false,
      compatibility: baseModelKeys.map((key) => ({ baseModel: key, support: null })),
      incompatible: baseModelKeys,
      alternativeGroups: [],
    };
  }

  // Get all generation support for the primary group
  const groupSupport = generationSupport.filter((s) => s.groupId === primaryGroup.id);

  // Check each base model's compatibility
  const compatibility: BaseModelCompatibilityStatus[] = baseModelKeys.map((key) => {
    const bm = baseModelByName.get(key);
    if (!bm) {
      return { baseModel: key, support: null };
    }

    // Find support record for this base model in the primary group
    const support = groupSupport.find((s) => s.baseModelId === bm.id);
    return {
      baseModel: key,
      support: support?.support ?? null,
    };
  });

  // Find incompatible base models
  const incompatible = compatibility.filter((c) => c.support === null).map((c) => c.baseModel);

  // Find alternative groups for incompatible base models
  const alternativeGroups: CompatibleGroupResult[] = [];

  if (incompatible.length > 0) {
    // Get all groups that have generation support
    const groupsWithSupport = new Set(generationSupport.map((s) => s.groupId));

    for (const groupId of groupsWithSupport) {
      // Skip the primary group
      if (groupId === primaryGroup.id) continue;

      const group = groupById.get(groupId);
      if (!group) continue;

      // Get support for this group
      const thisGroupSupport = generationSupport.filter((s) => s.groupId === groupId);

      // Check which incompatible base models this group supports
      const groupBaseModels: BaseModelCompatibilityStatus[] = [];

      for (const bmKey of incompatible) {
        const bm = baseModelByName.get(bmKey);
        if (!bm) continue;

        const support = thisGroupSupport.find((s) => s.baseModelId === bm.id);
        if (support) {
          groupBaseModels.push({
            baseModel: bmKey,
            support: support.support,
          });
        }
      }

      // Only include groups that support at least one incompatible base model
      if (groupBaseModels.length > 0) {
        alternativeGroups.push({
          groupId: group.id,
          groupName: group.name,
          groupKey: group.key,
          baseModels: groupBaseModels,
        });
      }
    }

    // Sort alternative groups by number of supported base models (descending)
    alternativeGroups.sort((a, b) => b.baseModels.length - a.baseModels.length);
  }

  return {
    primaryBaseModel: baseModelOrGroup,
    primaryGroup: {
      id: primaryGroup.id,
      name: primaryGroup.name,
      key: primaryGroup.key,
    },
    allCompatible: incompatible.length === 0,
    compatibility,
    incompatible,
    alternativeGroups,
  };
}
