/**
 * Base Model Constants V2 - Ecosystem-based Schema
 *
 * This file implements the redesigned schema with:
 * - Hierarchical ecosystems (parent/child relationships)
 * - Separated concerns: identity, support, settings
 * - Inheritance-based resolution
 * - Minimal explicit rules (derive support from ecosystem relationships)
 *
 * @see docs/generation-support-redesign.md for design documentation
 */

import { ModelType, type MediaType } from '~/shared/utils/prisma/enums';

// =============================================================================
// Types
// =============================================================================

export type SupportLevel = 'full' | 'partial';
export type SupportType = 'generation' | 'training' | 'auction';

// Generation modes supported by ecosystems
export type GenerationMode = 'txt2img' | 'img2img' | 'txt2vid' | 'img2vid' | 'vid2vid';

// -----------------------------------------------------------------------------
// Ecosystem Types
// -----------------------------------------------------------------------------

export type EcosystemRecord = {
  id: number;
  key: string; // Stable identifier for data mapping (e.g., 'SDXL', 'Flux1')
  name: string; // Lowercase ecosystem name for matching (e.g., 'sdxl', 'flux1')
  displayName: string; // Human/SEO friendly display name (e.g., 'Stable Diffusion XL')
  description?: string; // Brief description for UI display
  parentEcosystemId?: number;
  familyId?: number; // For UI family grouping
  sortOrder?: number; // For ordering in UI
};

export type EcosystemSupport = {
  ecosystemId: number;
  supportType: SupportType;
  modelTypes: ModelType[];
  disabled?: boolean; // Defaults to false (enabled)
};

export type EcosystemSettings = {
  ecosystemId: number;
  defaults?: {
    model?: { id: number };
    vae?: { id: number };
    engine?: string;
    sampler?: string;
    steps?: number;
    cfg?: number;
    width?: number;
    height?: number;
    /** If true, the model cannot be changed by the user (used for video ecosystems) */
    modelLocked?: boolean;
  };
  // TODO: Input constraints - needs more iteration
  // Complexity: constraints may depend on external context (e.g., membership tier)
};

export type CrossEcosystemRule = {
  sourceEcosystemId: number;
  targetEcosystemId: number;
  supportType: SupportType;
  modelTypes?: ModelType[];
  support: 'partial';
};

export type SupportOverride = {
  ecosystemId?: number;
  baseModelId?: number;
  supportType: SupportType;
  modelTypes?: ModelType[];
  disabled?: boolean; // Defaults to false (enabled)
};

export type WorkflowCategory =
  | 'text-to-image'
  | 'image-to-image'
  | 'image-enhancements'
  | 'text-to-video'
  | 'image-to-video'
  | 'video-enhancements';

export type WorkflowRecord = {
  /** Unique workflow key */
  key: string;
  /** Display label for the workflow */
  label: string;
  /** Input type required (text = txt2img, image = img2img, video = vid2vid) */
  inputType: 'text' | 'image' | 'video';
  /** Output type produced (defaults to 'image' if not specified) */
  outputType?: 'image' | 'video';
  /** UI category for grouping */
  category: WorkflowCategory;
  /** Ecosystem IDs that support this workflow */
  ecosystemIds: number[];
};

// -----------------------------------------------------------------------------
// Other Types (unchanged from v1)
// -----------------------------------------------------------------------------

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
};

export type BaseModelRecord = {
  id: number;
  name: string;
  description?: string;
  type: MediaType;
  ecosystemId: number; // Direct reference to ecosystem
  hidden?: boolean;
  disabled?: boolean; // Disables ALL support types (generation, training, auction, etc.)
  licenseId?: number;
};

// =============================================================================
// Ecosystem Constants
// =============================================================================

export const ECO = {
  // Root ecosystems - Image models
  SD1: 1,
  SD2: 2,
  SD3: 3,
  SD35M: 46, // SD 3.5 Medium - separate ecosystem
  SDXL: 4,
  SDXLDistilled: 5,
  Flux1: 6,
  FluxKrea: 7,
  Flux1Kontext: 8,
  Flux2: 9,
  Qwen: 10,
  Chroma: 11,
  HyDit1: 12,
  AuraFlow: 13,
  HiDream: 14,
  Kolors: 15,
  Lumina: 16,
  Mochi: 17,
  PixArtA: 18,
  PixArtE: 19,
  NanoBanana: 20,
  OpenAI: 21,
  Imagen4: 22,
  Seedream: 23,
  ZImageTurbo: 24,
  SCascade: 25,
  PlaygroundV2: 26,
  ODOR: 27,
  Other: 28,

  // Root ecosystems - Video models
  HyV1: 30,
  WanVideo: 31,
  WanVideo1_3B_T2V: 32,
  WanVideo14B_T2V: 33,
  WanVideo14B_I2V_480p: 34,
  WanVideo14B_I2V_720p: 35,
  WanVideo22_TI2V_5B: 36,
  WanVideo22_I2V_A14B: 37,
  WanVideo22_T2V_A14B: 38,
  WanVideo25_T2V: 39,
  WanVideo25_I2V: 40,
  CogVideoX: 41,
  LTXV: 42,
  Sora2: 43,
  Veo3: 44,
  SVD: 45,
  Vidu: 47,
  MiniMax: 48,
  Kling: 49,

  // Child ecosystems of SDXL
  Pony: 100,
  Illustrious: 101,
  NoobAI: 102,

  // Child ecosystems of AuraFlow
  PonyV7: 200,
} as const;

// =============================================================================
// Ecosystems
// =============================================================================

export const ecosystems: EcosystemRecord[] = [
  // Flux Family (familyId: 1)
  {
    id: ECO.Flux1,
    key: 'Flux1',
    name: 'flux1',
    displayName: 'Flux.1',
    familyId: 1,
    sortOrder: 0,
  },
  {
    id: ECO.FluxKrea,
    key: 'FluxKrea',
    name: 'fluxkrea',
    displayName: 'Flux.1 Krea',
    familyId: 1,
    sortOrder: 1,
  },
  {
    id: ECO.Flux1Kontext,
    key: 'Flux1Kontext',
    name: 'flux1kontext',
    displayName: 'Flux.1 Kontext',
    familyId: 1,
    sortOrder: 2,
  },
  {
    id: ECO.Flux2,
    key: 'Flux2',
    name: 'flux2',
    displayName: 'Flux.2',
    familyId: 1,
    sortOrder: 3,
  },

  // Stable Diffusion Family (familyId: 2)
  {
    id: ECO.SD1,
    key: 'SD1',
    name: 'sd1',
    displayName: 'Stable Diffusion 1.x',
    familyId: 2,
    sortOrder: 10,
  },
  {
    id: ECO.SD2,
    key: 'SD2',
    name: 'sd2',
    displayName: 'Stable Diffusion 2.x',
    familyId: 2,
    sortOrder: 11,
  },
  {
    id: ECO.SD3,
    key: 'SD3',
    name: 'sd3',
    displayName: 'Stable Diffusion 3',
    familyId: 2,
    sortOrder: 12,
  },
  {
    id: ECO.SD35M,
    key: 'SD3_5M',
    name: 'sd35m',
    displayName: 'Stable Diffusion 3.5 Medium',
    familyId: 2,
    sortOrder: 13,
  },
  {
    id: ECO.SDXL,
    key: 'SDXL',
    name: 'sdxl',
    displayName: 'Stable Diffusion XL',
    familyId: 2,
    sortOrder: 14,
  },
  {
    id: ECO.SDXLDistilled,
    key: 'SDXLDistilled',
    name: 'sdxldistilled',
    displayName: 'SDXL Distilled',
    familyId: 2,
    sortOrder: 15,
  },
  {
    id: ECO.SCascade,
    key: 'SCascade',
    name: 'scascade',
    displayName: 'Stable Cascade',
    familyId: 2,
    sortOrder: 16,
  },
  {
    id: ECO.SVD,
    key: 'SVD',
    name: 'svd',
    displayName: 'Stable Video Diffusion',
    familyId: 2,
    sortOrder: 17,
  },

  // SDXL Community Family (familyId: 3)
  {
    id: ECO.Illustrious,
    key: 'Illustrious',
    name: 'illustrious',
    displayName: 'Illustrious',
    parentEcosystemId: ECO.SDXL,
    familyId: 3,
    sortOrder: 20,
  },
  {
    id: ECO.NoobAI,
    key: 'NoobAI',
    name: 'noobai',
    displayName: 'NoobAI',
    parentEcosystemId: ECO.SDXL,
    familyId: 3,
    sortOrder: 21,
  },

  // Hunyuan Family (familyId: 4)
  {
    id: ECO.HyDit1,
    key: 'HyDit1',
    name: 'hydit1',
    displayName: 'Hunyuan DiT',
    familyId: 4,
    sortOrder: 40,
  },
  {
    id: ECO.HyV1,
    key: 'HyV1',
    name: 'hyv1',
    displayName: 'Hunyuan Video',
    familyId: 4,
    sortOrder: 41,
  },

  // Wan Video Family (familyId: 5)
  {
    id: ECO.WanVideo,
    key: 'WanVideo',
    name: 'wanvideo',
    displayName: 'Wan Video',
    familyId: 5,
    sortOrder: 50,
  },
  {
    id: ECO.WanVideo1_3B_T2V,
    key: 'WanVideo1_3B_T2V',
    name: 'wanvideo1_3b_t2v',
    displayName: 'Wan Video 1.3B T2V',
    familyId: 5,
    sortOrder: 51,
  },
  {
    id: ECO.WanVideo14B_T2V,
    key: 'WanVideo14B_T2V',
    name: 'wanvideo14b_t2v',
    displayName: 'Wan Video 14B T2V',
    familyId: 5,
    sortOrder: 52,
  },
  {
    id: ECO.WanVideo14B_I2V_480p,
    key: 'WanVideo14B_I2V_480p',
    name: 'wanvideo14b_i2v_480p',
    displayName: 'Wan Video 14B I2V 480p',
    familyId: 5,
    sortOrder: 53,
  },
  {
    id: ECO.WanVideo14B_I2V_720p,
    key: 'WanVideo14B_I2V_720p',
    name: 'wanvideo14b_i2v_720p',
    displayName: 'Wan Video 14B I2V 720p',
    familyId: 5,
    sortOrder: 54,
  },
  {
    id: ECO.WanVideo22_TI2V_5B,
    key: 'WanVideo-22-TI2V-5B',
    name: 'wanvideo-22-ti2v-5b',
    displayName: 'Wan Video 2.2 TI2V 5B',
    familyId: 5,
    sortOrder: 55,
  },
  {
    id: ECO.WanVideo22_I2V_A14B,
    key: 'WanVideo-22-I2V-A14B',
    name: 'wanvideo-22-i2v-a14b',
    displayName: 'Wan Video 2.2 I2V A14B',
    familyId: 5,
    sortOrder: 56,
  },
  {
    id: ECO.WanVideo22_T2V_A14B,
    key: 'WanVideo-22-T2V-A14B',
    name: 'wanvideo-22-t2v-a14b',
    displayName: 'Wan Video 2.2 T2V A14B',
    familyId: 5,
    sortOrder: 57,
  },
  {
    id: ECO.WanVideo25_T2V,
    key: 'WanVideo-25-T2V',
    name: 'wanvideo-25-t2v',
    displayName: 'Wan Video 2.5 T2V',
    familyId: 5,
    sortOrder: 58,
  },
  {
    id: ECO.WanVideo25_I2V,
    key: 'WanVideo-25-I2V',
    name: 'wanvideo-25-i2v',
    displayName: 'Wan Video 2.5 I2V',
    familyId: 5,
    sortOrder: 59,
  },

  // PixArt Family (familyId: 6)
  {
    id: ECO.PixArtA,
    key: 'PixArtA',
    name: 'pixarta',
    displayName: 'PixArt Alpha',
    familyId: 6,
    sortOrder: 60,
  },
  {
    id: ECO.PixArtE,
    key: 'PixArtE',
    name: 'pixarte',
    displayName: 'PixArt Sigma',
    familyId: 6,
    sortOrder: 61,
  },

  // Google Family (familyId: 7)
  {
    id: ECO.Imagen4,
    key: 'Imagen4',
    name: 'imagen4',
    displayName: 'Imagen 4',
    familyId: 7,
    sortOrder: 70,
  },
  {
    id: ECO.NanoBanana,
    key: 'NanoBanana',
    name: 'nanobanana',
    displayName: 'Nano Banana',
    familyId: 7,
    sortOrder: 71,
  },
  {
    id: ECO.Veo3,
    key: 'Veo3',
    name: 'veo3',
    displayName: 'Veo 3',
    familyId: 7,
    sortOrder: 0,
  },

  // OpenAI Family (familyId: 8)
  {
    id: ECO.OpenAI,
    key: 'OpenAI',
    name: 'openai',
    displayName: 'OpenAI',
    familyId: 8,
    sortOrder: 80,
  },
  {
    id: ECO.Sora2,
    key: 'Sora2',
    name: 'sora2',
    displayName: 'Sora 2',
    familyId: 8,
    sortOrder: 81,
  },

  // Pony Diffusion Family (familyId: 9)
  {
    id: ECO.Pony,
    key: 'Pony',
    name: 'pony',
    displayName: 'Pony Diffusion',
    parentEcosystemId: ECO.SDXL,
    familyId: 9,
    sortOrder: 30,
  },
  {
    id: ECO.PonyV7,
    key: 'PonyV7',
    name: 'ponyv7',
    displayName: 'Pony Diffusion V7',
    parentEcosystemId: ECO.AuraFlow,
    familyId: 9,
    sortOrder: 31,
  },

  // Qwen Family (familyId: 10)
  { id: ECO.Qwen, key: 'Qwen', name: 'qwen', displayName: 'Qwen', familyId: 10, sortOrder: 90 },

  // ZImageTurbo Family (familyId: 11)
  {
    id: ECO.ZImageTurbo,
    key: 'ZImageTurbo',
    name: 'zimageturbo',
    displayName: 'ZImageTurbo',
    familyId: 11,
    sortOrder: 100,
  },

  // ByteDance Family (familyId: 12)
  {
    id: ECO.Seedream,
    key: 'Seedream',
    name: 'seedream',
    displayName: 'Seedream',
    familyId: 12,
    sortOrder: 110,
  },

  // Standalone ecosystems (no family)
  { id: ECO.AuraFlow, key: 'AuraFlow', name: 'auraflow', displayName: 'AuraFlow', sortOrder: 200 },
  { id: ECO.Chroma, key: 'Chroma', name: 'chroma', displayName: 'Chroma', sortOrder: 201 },
  {
    id: ECO.CogVideoX,
    key: 'CogVideoX',
    name: 'cogvideox',
    displayName: 'CogVideoX',
    sortOrder: 202,
    // No generation support - training only
  },
  {
    id: ECO.HiDream,
    key: 'HiDream',
    name: 'hidream',
    displayName: 'HiDream',
    sortOrder: 203,
  },
  { id: ECO.Kolors, key: 'Kolors', name: 'kolors', displayName: 'Kolors', sortOrder: 204 },
  { id: ECO.LTXV, key: 'LTXV', name: 'ltxv', displayName: 'LTX Video', sortOrder: 205 },
  { id: ECO.Lumina, key: 'Lumina', name: 'lumina', displayName: 'Lumina', sortOrder: 206 },
  {
    id: ECO.Mochi,
    key: 'Mochi',
    name: 'mochi',
    displayName: 'Mochi',
    sortOrder: 207,
  },
  {
    id: ECO.Vidu,
    key: 'Vidu',
    name: 'vidu',
    displayName: 'Vidu Q1',
    sortOrder: 210,
    // txt2vid + img2vid (no vid2vid support currently)
  },
  {
    id: ECO.MiniMax,
    key: 'MiniMax',
    name: 'minimax',
    displayName: 'Hailuo by MiniMax',
    sortOrder: 211,
    // txt2vid + img2vid (no vid2vid support currently)
  },
  {
    id: ECO.Kling,
    key: 'Kling',
    name: 'kling',
    displayName: 'Kling',
    sortOrder: 212,
    // txt2vid + img2vid (no vid2vid support currently)
  },
  { id: ECO.ODOR, key: 'ODOR', name: 'odor', displayName: 'ODOR', sortOrder: 208 },
  {
    id: ECO.PlaygroundV2,
    key: 'PlaygroundV2',
    name: 'playgroundv2',
    displayName: 'Playground v2',
    sortOrder: 209,
  },
  {
    id: ECO.Other,
    key: 'Other',
    name: 'other',
    displayName: 'Other',
    sortOrder: 999,
  },
];

export const ecosystemById = new Map(ecosystems.map((e) => [e.id, e]));
export const ecosystemByKey = new Map(ecosystems.map((e) => [e.key, e]));
export const ecosystemByName = new Map(ecosystems.map((e) => [e.name, e]));

// =============================================================================
// Ecosystem Support
// =============================================================================

const fullAddonTypes = [
  ModelType.Checkpoint,
  ModelType.LORA,
  ModelType.DoRA,
  ModelType.LoCon,
  ModelType.VAE,
  ModelType.TextualInversion,
];

const checkpointAndLora = [ModelType.Checkpoint, ModelType.LORA];
const checkpointOnly = [ModelType.Checkpoint];
const loraOnly = [ModelType.LORA];

export const ecosystemSupport: EcosystemSupport[] = [
  // SD1 - full addon support
  { ecosystemId: ECO.SD1, supportType: 'generation', modelTypes: fullAddonTypes },
  { ecosystemId: ECO.SD1, supportType: 'training', modelTypes: [ModelType.LORA] },

  // SDXL - full addon support (Pony, Illustrious, NoobAI inherit this)
  { ecosystemId: ECO.SDXL, supportType: 'generation', modelTypes: fullAddonTypes },
  { ecosystemId: ECO.SDXL, supportType: 'training', modelTypes: [ModelType.LORA] },
  { ecosystemId: ECO.SDXL, supportType: 'auction', modelTypes: checkpointAndLora },

  // Flux1 - checkpoint and LORA only
  { ecosystemId: ECO.Flux1, supportType: 'generation', modelTypes: checkpointAndLora },
  { ecosystemId: ECO.Flux1, supportType: 'training', modelTypes: [ModelType.LORA] },

  // FluxKrea - checkpoint and LORA
  { ecosystemId: ECO.FluxKrea, supportType: 'generation', modelTypes: checkpointAndLora },

  // Flux1Kontext - checkpoint only (no LORA)
  { ecosystemId: ECO.Flux1Kontext, supportType: 'generation', modelTypes: checkpointOnly },

  // Flux2 - checkpoint and LORA
  { ecosystemId: ECO.Flux2, supportType: 'generation', modelTypes: checkpointAndLora },

  // Chroma - full addon support
  { ecosystemId: ECO.Chroma, supportType: 'generation', modelTypes: fullAddonTypes },
  { ecosystemId: ECO.Chroma, supportType: 'training', modelTypes: [ModelType.LORA] },

  // Qwen - checkpoint and LORA
  { ecosystemId: ECO.Qwen, supportType: 'generation', modelTypes: checkpointAndLora },
  { ecosystemId: ECO.Qwen, supportType: 'training', modelTypes: [ModelType.LORA] },

  // HyV1 (Hunyuan Video) - LORA only
  { ecosystemId: ECO.HyV1, supportType: 'generation', modelTypes: loraOnly },

  // WanVideo ecosystems
  { ecosystemId: ECO.WanVideo, supportType: 'generation', modelTypes: loraOnly },
  { ecosystemId: ECO.WanVideo14B_T2V, supportType: 'generation', modelTypes: checkpointAndLora },
  {
    ecosystemId: ECO.WanVideo14B_I2V_480p,
    supportType: 'generation',
    modelTypes: checkpointAndLora,
  },
  {
    ecosystemId: ECO.WanVideo14B_I2V_720p,
    supportType: 'generation',
    modelTypes: checkpointAndLora,
  },
  { ecosystemId: ECO.WanVideo22_TI2V_5B, supportType: 'generation', modelTypes: checkpointAndLora },
  {
    ecosystemId: ECO.WanVideo22_I2V_A14B,
    supportType: 'generation',
    modelTypes: checkpointAndLora,
  },
  {
    ecosystemId: ECO.WanVideo22_T2V_A14B,
    supportType: 'generation',
    modelTypes: checkpointAndLora,
  },
  { ecosystemId: ECO.WanVideo25_T2V, supportType: 'generation', modelTypes: checkpointOnly },
  { ecosystemId: ECO.WanVideo25_I2V, supportType: 'generation', modelTypes: checkpointOnly },

  // HiDream - checkpoint and LORA
  { ecosystemId: ECO.HiDream, supportType: 'generation', modelTypes: checkpointAndLora },
  { ecosystemId: ECO.HiDream, supportType: 'training', modelTypes: [ModelType.LORA] },

  // NanoBanana - checkpoint only
  { ecosystemId: ECO.NanoBanana, supportType: 'generation', modelTypes: checkpointOnly },

  // OpenAI - checkpoint only
  { ecosystemId: ECO.OpenAI, supportType: 'generation', modelTypes: checkpointOnly },

  // Imagen4 - checkpoint only
  { ecosystemId: ECO.Imagen4, supportType: 'generation', modelTypes: checkpointOnly },

  // Veo3 - checkpoint only
  { ecosystemId: ECO.Veo3, supportType: 'generation', modelTypes: checkpointOnly },

  // Seedream - checkpoint only
  { ecosystemId: ECO.Seedream, supportType: 'generation', modelTypes: checkpointOnly },

  // Sora2 - checkpoint only
  { ecosystemId: ECO.Sora2, supportType: 'generation', modelTypes: checkpointOnly },

  // Mochi - checkpoint only
  { ecosystemId: ECO.Mochi, supportType: 'generation', modelTypes: checkpointOnly },

  // Vidu - checkpoint only
  { ecosystemId: ECO.Vidu, supportType: 'generation', modelTypes: checkpointOnly },

  // MiniMax (Hailuo) - checkpoint only
  { ecosystemId: ECO.MiniMax, supportType: 'generation', modelTypes: checkpointOnly },

  // Kling - checkpoint only
  { ecosystemId: ECO.Kling, supportType: 'generation', modelTypes: checkpointOnly },

  // PonyV7 - checkpoint and LORA (based on AuraFlow)
  { ecosystemId: ECO.PonyV7, supportType: 'generation', modelTypes: checkpointAndLora },

  // ZImageTurbo - checkpoint and LORA
  { ecosystemId: ECO.ZImageTurbo, supportType: 'generation', modelTypes: checkpointAndLora },
  { ecosystemId: ECO.ZImageTurbo, supportType: 'training', modelTypes: [ModelType.LORA] },
];

// =============================================================================
// Ecosystem Settings
// =============================================================================

export const ecosystemSettings: EcosystemSettings[] = [
  {
    ecosystemId: ECO.SD1,
    defaults: {
      model: { id: 128713 },
      width: 512,
      height: 512,
      cfg: 7,
      steps: 25,
    },
  },
  {
    ecosystemId: ECO.SDXL,
    defaults: {
      model: { id: 128078 },
      width: 1024,
      height: 1024,
      cfg: 7,
      steps: 25,
    },
  },
  {
    ecosystemId: ECO.Pony,
    defaults: {
      model: { id: 290640 },
    },
  },
  {
    ecosystemId: ECO.Illustrious,
    defaults: {
      model: { id: 889818 },
    },
  },
  {
    ecosystemId: ECO.NoobAI,
    defaults: {
      model: { id: 1190596 },
    },
  },
  {
    ecosystemId: ECO.Flux1,
    defaults: {
      model: { id: 691639 },
      width: 1024,
      height: 1024,
      cfg: 1,
      steps: 4,
    },
  },
  {
    ecosystemId: ECO.FluxKrea,
    defaults: {
      model: { id: 2068000 },
    },
  },
  {
    ecosystemId: ECO.Flux1Kontext,
    defaults: {
      model: { id: 1892509 },
    },
  },
  {
    ecosystemId: ECO.Flux2,
    defaults: {
      model: { id: 2439067 },
    },
  },
  {
    ecosystemId: ECO.Chroma,
    defaults: {
      model: { id: 2164239 },
      width: 1024,
      height: 1024,
    },
  },
  {
    ecosystemId: ECO.HiDream,
    defaults: {
      model: { id: 1771369 },
      width: 1024,
      height: 1024,
    },
  },
  {
    ecosystemId: ECO.Qwen,
    defaults: {
      model: { id: 2113658 },
    },
  },
  {
    ecosystemId: ECO.HyV1,
    defaults: {
      model: { id: 1314512 },
      engine: 'hunyuan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo,
    defaults: {
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo1_3B_T2V,
    defaults: {
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo14B_T2V,
    defaults: {
      model: { id: 1707796 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo14B_I2V_480p,
    defaults: {
      model: { id: 1501125 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo14B_I2V_720p,
    defaults: {
      model: { id: 1501344 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo22_TI2V_5B,
    defaults: {
      model: { id: 2114110 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo22_I2V_A14B,
    defaults: {
      model: { id: 2114157 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo22_T2V_A14B,
    defaults: {
      model: { id: 2114154 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo25_T2V,
    defaults: {
      model: { id: 2254989 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.WanVideo25_I2V,
    defaults: {
      model: { id: 2254963 },
      engine: 'wan',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.Mochi,
    defaults: {
      model: { id: 1034189 },
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.LTXV,
    defaults: {
      model: { id: 1499827 },
      engine: 'lightricks',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.Veo3,
    defaults: {
      model: { id: 1885367 },
      engine: 'veo3',
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.NanoBanana,
    defaults: {
      model: { id: 2154472 },
    },
  },
  {
    ecosystemId: ECO.OpenAI,
    defaults: {
      model: { id: 1733399 },
    },
  },
  {
    ecosystemId: ECO.Imagen4,
    defaults: {
      model: { id: 1889632 },
    },
  },
  {
    ecosystemId: ECO.Seedream,
    defaults: {
      model: { id: 2208278 },
    },
  },
  {
    ecosystemId: ECO.ZImageTurbo,
    defaults: {
      model: { id: 2442439 },
      width: 1024,
      height: 1024,
    },
  },
  {
    ecosystemId: ECO.PonyV7,
    defaults: {
      model: { id: 2152373 },
    },
  },
  {
    ecosystemId: ECO.Sora2,
    defaults: {
      model: { id: 2320065 },
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.Vidu,
    defaults: {
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.MiniMax,
    defaults: {
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.Kling,
    defaults: {
      modelLocked: true,
    },
  },
  {
    ecosystemId: ECO.Other,
    defaults: {
      model: { id: 164821 },
      width: 1024,
      height: 1024,
    },
  },
];

// =============================================================================
// Workflows
// =============================================================================

/** SD family ecosystem IDs (img2img support) */
const SD_FAMILY_IDS = [ECO.SD1, ECO.SDXL, ECO.Pony, ECO.Illustrious, ECO.NoobAI];

/** Image ecosystems that support txt2img (all image ecosystems with generation support) */
const TXT2IMG_IDS = [
  // SD family
  ECO.SD1,
  ECO.SDXL,
  ECO.Pony,
  ECO.Illustrious,
  ECO.NoobAI,
  // Flux family
  ECO.Flux1,
  ECO.FluxKrea,
  ECO.Flux1Kontext,
  ECO.Flux2,
  // Other image ecosystems
  ECO.Chroma,
  ECO.Qwen,
  ECO.HiDream,
  ECO.NanoBanana,
  ECO.OpenAI,
  ECO.Imagen4,
  ECO.Seedream,
  ECO.PonyV7,
  ECO.ZImageTurbo,
];

/** Video ecosystems that support txt2vid (text-to-video) */
const TXT2VID_IDS = [
  ECO.HyV1,
  ECO.WanVideo,
  ECO.WanVideo14B_T2V,
  ECO.WanVideo22_TI2V_5B, // TI2V supports both text and image
  ECO.WanVideo22_T2V_A14B,
  ECO.WanVideo25_T2V,
  ECO.Veo3,
  ECO.Sora2,
  ECO.Mochi,
  ECO.Vidu,
  ECO.MiniMax,
  ECO.Kling,
];

/** Video ecosystems that support img2vid (image-to-video) */
const IMG2VID_IDS = [
  ECO.HyV1,
  ECO.WanVideo,
  ECO.WanVideo14B_I2V_480p,
  ECO.WanVideo14B_I2V_720p,
  ECO.WanVideo22_TI2V_5B, // TI2V supports both text and image
  ECO.WanVideo22_I2V_A14B,
  ECO.WanVideo25_I2V,
  ECO.Veo3,
  ECO.Sora2,
  ECO.Vidu,
  ECO.MiniMax,
  ECO.Kling,
];

/**
 * Workflow definitions with display labels and ecosystem support.
 * Workflows determine what generation feature is used.
 * Each workflow explicitly lists the ecosystem IDs that support it.
 */
export const workflows: WorkflowRecord[] = [
  // Text to Image workflows
  {
    key: 'txt2img',
    label: 'Create Image',
    inputType: 'text',
    category: 'text-to-image',
    ecosystemIds: TXT2IMG_IDS,
  },
  {
    key: 'draft',
    label: 'Draft',
    inputType: 'text',
    category: 'text-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },
  {
    key: 'txt2img:face-fix',
    label: 'Create + Face Fix',
    inputType: 'text',
    category: 'text-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },
  {
    key: 'txt2img:hires-fix',
    label: 'Create + Hires Fix',
    inputType: 'text',
    category: 'text-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  // Image to Image workflows
  {
    key: 'img2img',
    label: 'Variations',
    inputType: 'image',
    category: 'image-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },
  {
    key: 'img2img:face-fix',
    label: 'Face Fix',
    inputType: 'image',
    category: 'image-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },
  {
    key: 'img2img:hires-fix',
    label: 'Hires Fix',
    inputType: 'image',
    category: 'image-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },
  {
    key: 'image-edit',
    label: 'Image Edit',
    inputType: 'image',
    category: 'image-to-image',
    ecosystemIds: [ECO.Qwen, ECO.Seedream, ECO.NanoBanana, ECO.OpenAI, ECO.Flux2],
  },

  // Image enhancement workflows
  {
    key: 'img2img:remove-background',
    label: 'Remove Background',
    inputType: 'image',
    category: 'image-enhancements',
    ecosystemIds: [], // No ecosystems currently support this
  },
  {
    key: 'img2img:upscale',
    label: 'Upscale',
    inputType: 'image',
    category: 'image-enhancements',
    ecosystemIds: [], // No ecosystems currently support this
  },

  // Video workflows
  {
    key: 'txt2vid',
    label: 'Create Video',
    inputType: 'text',
    outputType: 'video',
    category: 'text-to-video',
    ecosystemIds: TXT2VID_IDS,
  },
  {
    key: 'img2vid',
    label: 'Animate Image',
    inputType: 'image',
    outputType: 'video',
    category: 'image-to-video',
    ecosystemIds: IMG2VID_IDS,
  },

  // Video enhancement workflows (no ecosystems currently support vid2vid)
  {
    key: 'vid2vid:upscale',
    label: 'Upscale',
    inputType: 'video',
    outputType: 'video',
    category: 'video-enhancements',
    ecosystemIds: [], // No ecosystems currently support vid2vid
  },
  {
    key: 'vid2vid:interpolate',
    label: 'Interpolate',
    inputType: 'video',
    outputType: 'video',
    category: 'video-enhancements',
    ecosystemIds: [], // No ecosystems currently support vid2vid
  },
];

/** Lookup map for workflows by key */
export const workflowByKey = new Map(workflows.map((w) => [w.key, w]));

// =============================================================================
// Cross-Ecosystem Rules
// =============================================================================

export const crossEcosystemRules: CrossEcosystemRule[] = [
  // ==========================================================================
  // SD1 → SDXL Family
  // ==========================================================================
  // SD1 TextualInversion works in SDXL family (and its children: Pony, Illustrious, NoobAI)
  {
    sourceEcosystemId: ECO.SD1,
    targetEcosystemId: ECO.SDXL,
    supportType: 'generation',
    modelTypes: [ModelType.TextualInversion],
    support: 'partial',
  },
  // SD1 TextualInversion also works directly in Pony
  {
    sourceEcosystemId: ECO.SD1,
    targetEcosystemId: ECO.Pony,
    supportType: 'generation',
    modelTypes: [ModelType.TextualInversion],
    support: 'partial',
  },
  // SD1 TextualInversion also works directly in Illustrious
  {
    sourceEcosystemId: ECO.SD1,
    targetEcosystemId: ECO.Illustrious,
    supportType: 'generation',
    modelTypes: [ModelType.TextualInversion],
    support: 'partial',
  },
  // SD1 TextualInversion also works directly in NoobAI
  {
    sourceEcosystemId: ECO.SD1,
    targetEcosystemId: ECO.NoobAI,
    supportType: 'generation',
    modelTypes: [ModelType.TextualInversion],
    support: 'partial',
  },

  // ==========================================================================
  // Flux Family Cross-Support
  // ==========================================================================
  // Flux1 LORA works partially in FluxKrea
  {
    sourceEcosystemId: ECO.Flux1,
    targetEcosystemId: ECO.FluxKrea,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  // FluxKrea LORA works partially in Flux1
  {
    sourceEcosystemId: ECO.FluxKrea,
    targetEcosystemId: ECO.Flux1,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },

  // ==========================================================================
  // WanVideo 14B ↔ WanVideo 2.2 Cross-Support
  // ==========================================================================
  // WanVideo 2.2 LORA works partially in WanVideo 14B T2V
  {
    sourceEcosystemId: ECO.WanVideo22_T2V_A14B,
    targetEcosystemId: ECO.WanVideo14B_T2V,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo22_I2V_A14B,
    targetEcosystemId: ECO.WanVideo14B_T2V,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo22_TI2V_5B,
    targetEcosystemId: ECO.WanVideo14B_T2V,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },

  // WanVideo 2.2 LORA works partially in WanVideo 14B I2V 480p
  {
    sourceEcosystemId: ECO.WanVideo22_T2V_A14B,
    targetEcosystemId: ECO.WanVideo14B_I2V_480p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo22_I2V_A14B,
    targetEcosystemId: ECO.WanVideo14B_I2V_480p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo22_TI2V_5B,
    targetEcosystemId: ECO.WanVideo14B_I2V_480p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },

  // WanVideo 2.2 LORA works partially in WanVideo 14B I2V 720p
  {
    sourceEcosystemId: ECO.WanVideo22_T2V_A14B,
    targetEcosystemId: ECO.WanVideo14B_I2V_720p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo22_I2V_A14B,
    targetEcosystemId: ECO.WanVideo14B_I2V_720p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo22_TI2V_5B,
    targetEcosystemId: ECO.WanVideo14B_I2V_720p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },

  // WanVideo 14B LORA works partially in WanVideo 2.2 T2V
  {
    sourceEcosystemId: ECO.WanVideo14B_T2V,
    targetEcosystemId: ECO.WanVideo22_T2V_A14B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_480p,
    targetEcosystemId: ECO.WanVideo22_T2V_A14B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_720p,
    targetEcosystemId: ECO.WanVideo22_T2V_A14B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },

  // WanVideo 14B LORA works partially in WanVideo 2.2 I2V
  {
    sourceEcosystemId: ECO.WanVideo14B_T2V,
    targetEcosystemId: ECO.WanVideo22_I2V_A14B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_480p,
    targetEcosystemId: ECO.WanVideo22_I2V_A14B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_720p,
    targetEcosystemId: ECO.WanVideo22_I2V_A14B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },

  // WanVideo 14B LORA works partially in WanVideo 2.2 TI2V
  {
    sourceEcosystemId: ECO.WanVideo14B_T2V,
    targetEcosystemId: ECO.WanVideo22_TI2V_5B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_480p,
    targetEcosystemId: ECO.WanVideo22_TI2V_5B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_720p,
    targetEcosystemId: ECO.WanVideo22_TI2V_5B,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },

  // ==========================================================================
  // WanVideo 14B I2V 480p ↔ 720p Cross-Support
  // ==========================================================================
  // These two I2V models share LORA compatibility
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_480p,
    targetEcosystemId: ECO.WanVideo14B_I2V_720p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
  {
    sourceEcosystemId: ECO.WanVideo14B_I2V_720p,
    targetEcosystemId: ECO.WanVideo14B_I2V_480p,
    supportType: 'generation',
    modelTypes: [ModelType.LORA],
    support: 'partial',
  },
];

// =============================================================================
// Support Overrides
// =============================================================================

// Base model ID constants
export const BM = {
  AuraFlow: 1,
  Chroma: 2,
  CogVideoX: 3,
  Flux1S: 4,
  Flux1D: 5,
  Flux1Krea: 6,
  Flux1Kontext: 7,
  Flux2D: 8,
  HiDream: 9,
  Hunyuan1: 10,
  HunyuanVideo: 11,
  Illustrious: 12,
  Imagen4: 13,
  Kolors: 14,
  LTXV: 15,
  Lumina: 16,
  Mochi: 17,
  NanoBanana: 18,
  NoobAI: 19,
  ODOR: 20,
  OpenAI: 21,
  Other: 22,
  PixArtA: 23,
  PixArtE: 24,
  PlaygroundV2: 25,
  Pony: 26,
  PonyV7: 27,
  Qwen: 28,
  StableCascade: 29,
  SD14: 30,
  SD15: 31,
  SD15LCM: 32,
  SD15Hyper: 33,
  SD20: 34,
  SD20_768: 35,
  SD21: 36,
  SD21_768: 37,
  SD21Unclip: 38,
  SD3: 39,
  SD35: 40,
  SD35Large: 41,
  SD35LargeTurbo: 42,
  SD35Medium: 43,
  SDXL09: 44,
  SDXL10: 45,
  SDXL10LCM: 46,
  SDXLLightning: 47,
  SDXLHyper: 48,
  SDXLTurbo: 49,
  SDXLDistilled: 50,
  Seedream: 51,
  SVD: 52,
  SVDXT: 53,
  Sora2: 54,
  Veo3: 55,
  WanVideo: 56,
  WanVideo13BT2V: 57,
  WanVideo14BT2V: 58,
  WanVideo14BI2V480p: 59,
  WanVideo14BI2V720p: 60,
  WanVideo22TI2V5B: 61,
  WanVideo22I2VA14B: 62,
  WanVideo22T2VA14B: 63,
  WanVideo25T2V: 64,
  WanVideo25I2V: 65,
  ZImageTurbo: 66,
  Vidu: 67,
  MiniMax: 68,
  Kling: 69,
} as const;

export const supportOverrides: SupportOverride[] = [
  // NOTE: Models with `disabled: true` on BaseModelRecord don't need entries here.
  // The disabled flag provides root-level disable for all support types.
  // Disabled models: SD3, SD35, SD35Large, SD35LargeTurbo, SD35Medium, SDXLTurbo, SVD, SVDXT
  // Group-level overrides (for when only specific support types should be disabled)
  // SD3 group - no training (redundant since all SD3 models are disabled, but kept for documentation)
  // { ecosystemId: ECO.SD3, supportType: 'training', enabled: false },
  // { ecosystemId: ECO.SD35M, supportType: 'training', enabled: false },
];

// =============================================================================
// Licenses (unchanged from v1)
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

export const licenseById = new Map(licenses.map((l) => [l.id, l]));

// =============================================================================
// Ecosystem Families
// =============================================================================

export const ecosystemFamilies: BaseModelFamilyRecord[] = [
  {
    id: 1,
    name: 'Flux',
    description: "Black Forest Labs' family of state-of-the-art image generation models",
  },
  {
    id: 2,
    name: 'Stable Diffusion',
    description: "Stability AI's foundational open-source diffusion models",
  },
  {
    id: 3,
    name: 'SDXL Community',
    description: 'Community-trained models built on the SDXL architecture',
  },
  {
    id: 4,
    name: 'Hunyuan',
    description: "Tencent's family of image and video generation models",
  },
  {
    id: 5,
    name: 'Wan Video',
    description: "Alibaba's video generation model series with various sizes and modes",
  },
  {
    id: 6,
    name: 'PixArt',
    description: 'Efficient transformer-based text-to-image models',
  },
  {
    id: 7,
    name: 'Google',
    description: "Google's image and video generation models",
  },
  {
    id: 8,
    name: 'OpenAI',
    description: "OpenAI's creative image and video generation models",
  },
  {
    id: 9,
    name: 'Pony Diffusion',
    description: 'Community models with extensive tag-based prompt support',
  },
  {
    id: 10,
    name: 'Qwen',
    description: "Alibaba's multimodal model family with image generation capabilities",
  },
  {
    id: 11,
    name: 'ZImageTurbo',
    description: 'Fast turbo-optimized image generation models',
  },
  {
    id: 12,
    name: 'ByteDance',
    description: "ByteDance's image and video generation models",
  },
];

export const ecosystemFamilyById = new Map(ecosystemFamilies.map((f) => [f.id, f]));

// NOTE: BaseModelGroups have been removed. Base models now reference ecosystems directly.

// =============================================================================
// Base Models (with ecosystemId)
// =============================================================================

export const baseModels: BaseModelRecord[] = [
  // AuraFlow
  {
    id: BM.AuraFlow,
    name: 'AuraFlow',
    description: 'Open-source text-to-image model from Fal.ai with strong prompt adherence',
    type: 'image',
    ecosystemId: ECO.AuraFlow,
    licenseId: 13,
  },

  // Chroma
  {
    id: BM.Chroma,
    name: 'Chroma',
    description: 'Open-source model based on Flux architecture with improved color and composition',
    type: 'image',
    ecosystemId: ECO.Chroma,
    licenseId: 13,
  },

  // CogVideoX
  {
    id: BM.CogVideoX,
    name: 'CogVideoX',
    description: 'Text-to-video diffusion model from Tsinghua University and ZhipuAI',
    type: 'image',
    ecosystemId: ECO.CogVideoX,
    licenseId: 17,
  },

  // Flux.1
  {
    id: BM.Flux1S,
    name: 'Flux.1 S',
    description: 'First generation Flux schnell variant',
    type: 'image',
    ecosystemId: ECO.Flux1,
    licenseId: 13,
  },
  {
    id: BM.Flux1D,
    name: 'Flux.1 D',
    description: 'First generation Flux dev variant',
    type: 'image',
    ecosystemId: ECO.Flux1,
    licenseId: 14,
  },
  {
    id: BM.Flux1Krea,
    name: 'Flux.1 Krea',
    description: 'Krea-trained variant of Flux optimized for creative generation',
    type: 'image',
    ecosystemId: ECO.FluxKrea,
    licenseId: 14,
  },
  {
    id: BM.Flux1Kontext,
    name: 'Flux.1 Kontext',
    description: 'Flux variant specialized for context-aware image editing and generation',
    type: 'image',
    ecosystemId: ECO.Flux1Kontext,
    licenseId: 14,
  },
  {
    id: BM.Flux2D,
    name: 'Flux.2 D',
    description: 'Next-generation Flux with enhanced capabilities',
    type: 'image',
    ecosystemId: ECO.Flux2,
    licenseId: 14,
  },

  // HiDream
  {
    id: BM.HiDream,
    name: 'HiDream',
    description: 'High-resolution image generation model optimized for detailed outputs',
    type: 'image',
    ecosystemId: ECO.HiDream,
    licenseId: 19,
  },

  // Hunyuan
  {
    id: BM.Hunyuan1,
    name: 'Hunyuan 1',
    description: 'Diffusion transformer for bilingual Chinese-English image generation',
    type: 'image',
    ecosystemId: ECO.HyDit1,
    licenseId: 10,
  },
  {
    id: BM.HunyuanVideo,
    name: 'Hunyuan Video',
    description: 'Video generation model with strong motion coherence',
    type: 'video',
    ecosystemId: ECO.HyV1,
    licenseId: 11,
  },

  // Illustrious
  {
    id: BM.Illustrious,
    name: 'Illustrious',
    description: 'SDXL-based model specialized for anime and illustration styles',
    type: 'image',
    ecosystemId: ECO.Illustrious,
    licenseId: 15,
  },

  // Imagen4
  {
    id: BM.Imagen4,
    name: 'Imagen4',
    description: 'Text-to-image model with photorealistic capabilities',
    type: 'image',
    ecosystemId: ECO.Imagen4,
    hidden: true,
    licenseId: 21,
  },

  // Kolors
  {
    id: BM.Kolors,
    name: 'Kolors',
    description: "Kuaishou's bilingual image generation model with vibrant color output",
    type: 'image',
    ecosystemId: ECO.Kolors,
    licenseId: 12,
  },

  // LTXV
  {
    id: BM.LTXV,
    name: 'LTXV',
    description: "Lightricks' efficient video generation model for fast rendering",
    type: 'video',
    ecosystemId: ECO.LTXV,
    licenseId: 16,
  },

  // Lumina
  {
    id: BM.Lumina,
    name: 'Lumina',
    description: 'Open-source model with strong foundations',
    type: 'image',
    ecosystemId: ECO.Lumina,
    licenseId: 13,
  },

  // Mochi
  {
    id: BM.Mochi,
    name: 'Mochi',
    description: "Genmo's video generation model with realistic motion synthesis",
    type: 'image',
    ecosystemId: ECO.Mochi,
    licenseId: 13,
  },

  // Nano Banana
  {
    id: BM.NanoBanana,
    name: 'Nano Banana',
    description: 'Experimental image generation model',
    type: 'image',
    ecosystemId: ECO.NanoBanana,
    hidden: true,
    licenseId: 21,
  },

  // NoobAI
  {
    id: BM.NoobAI,
    name: 'NoobAI',
    description: 'SDXL-based model trained for anime and stylized content',
    type: 'image',
    ecosystemId: ECO.NoobAI,
    licenseId: 18,
  },

  // ODOR
  {
    id: BM.ODOR,
    name: 'ODOR',
    description: 'Experimental diffusion model architecture',
    type: 'image',
    ecosystemId: ECO.ODOR,
    hidden: true,
  },

  // OpenAI
  {
    id: BM.OpenAI,
    name: 'OpenAI',
    description: 'Image generation models including DALL-E',
    type: 'image',
    ecosystemId: ECO.OpenAI,
    hidden: true,
    licenseId: 20,
  },

  // Other
  {
    id: BM.Other,
    name: 'Other',
    description: "Models that don't fit into standard categories",
    type: 'image',
    ecosystemId: ECO.Other,
  },

  // PixArt
  {
    id: BM.PixArtA,
    name: 'PixArt a',
    description: 'Efficient transformer-based model with fast training and strong quality',
    type: 'image',
    ecosystemId: ECO.PixArtA,
    licenseId: 3,
  },
  {
    id: BM.PixArtE,
    name: 'PixArt E',
    description: 'Enhanced PixArt with 4K resolution support and improved detail',
    type: 'image',
    ecosystemId: ECO.PixArtE,
    licenseId: 3,
  },

  // Playground v2
  {
    id: BM.PlaygroundV2,
    name: 'Playground v2',
    description: "Playground AI's model optimized for aesthetic image generation",
    type: 'image',
    ecosystemId: ECO.PlaygroundV2,
    hidden: true,
    licenseId: 6,
  },

  // Pony
  {
    id: BM.Pony,
    name: 'Pony',
    description: 'SDXL-based model with extensive tag-based prompt support',
    type: 'image',
    ecosystemId: ECO.Pony,
    licenseId: 3,
  },
  {
    id: BM.PonyV7,
    name: 'Pony V7',
    description: 'Latest Pony Diffusion built on AuraFlow architecture',
    type: 'image',
    ecosystemId: ECO.PonyV7,
    licenseId: 24,
  },

  // Qwen
  {
    id: BM.Qwen,
    name: 'Qwen',
    description: 'Multimodal model with image generation capabilities',
    type: 'image',
    ecosystemId: ECO.Qwen,
    licenseId: 13,
  },

  // Stable Cascade
  {
    id: BM.StableCascade,
    name: 'Stable Cascade',
    description: 'Cascaded latent diffusion model for high-resolution output',
    type: 'image',
    ecosystemId: ECO.SCascade,
    hidden: true,
    licenseId: 8,
  },

  // SD 1.x
  {
    id: BM.SD14,
    name: 'SD 1.4',
    description: 'The original Stable Diffusion with broad community support',
    type: 'image',
    ecosystemId: ECO.SD1,
    licenseId: 1,
  },
  {
    id: BM.SD15,
    name: 'SD 1.5',
    description: 'The original Stable Diffusion with broad community support',
    type: 'image',
    ecosystemId: ECO.SD1,
    licenseId: 1,
  },
  {
    id: BM.SD15LCM,
    name: 'SD 1.5 LCM',
    description: 'SD 1.5 with Latent Consistency Model for faster inference',
    type: 'image',
    ecosystemId: ECO.SD1,
    licenseId: 3,
  },
  {
    id: BM.SD15Hyper,
    name: 'SD 1.5 Hyper',
    description: 'SD 1.5 with Hyper optimization for reduced steps',
    type: 'image',
    ecosystemId: ECO.SD1,
    licenseId: 3,
  },

  // SD 2.x
  {
    id: BM.SD20,
    name: 'SD 2.0',
    description: 'Second generation SD with improved architecture',
    type: 'image',
    ecosystemId: ECO.SD2,
    licenseId: 1,
  },
  {
    id: BM.SD20_768,
    name: 'SD 2.0 768',
    description: 'SD 2.0 with 768px support',
    type: 'image',
    ecosystemId: ECO.SD2,
    hidden: true,
    licenseId: 1,
  },
  {
    id: BM.SD21,
    name: 'SD 2.1',
    description: 'Second generation SD with improved architecture and 768px support',
    type: 'image',
    ecosystemId: ECO.SD2,
    licenseId: 1,
  },
  {
    id: BM.SD21_768,
    name: 'SD 2.1 768',
    description: 'SD 2.1 with 768px support',
    type: 'image',
    ecosystemId: ECO.SD2,
    hidden: true,
    licenseId: 1,
  },
  {
    id: BM.SD21Unclip,
    name: 'SD 2.1 Unclip',
    description: 'SD 2.1 variant with image-to-image capabilities',
    type: 'image',
    ecosystemId: ECO.SD2,
    hidden: true,
    licenseId: 1,
  },

  // SD 3.x - fully disabled (no support for any type)
  {
    id: BM.SD3,
    name: 'SD 3',
    description: 'Multimodal diffusion transformer architecture',
    type: 'image',
    ecosystemId: ECO.SD3,
    hidden: true,
    disabled: true,
    licenseId: 9,
  },
  {
    id: BM.SD35,
    name: 'SD 3.5',
    description: 'Multimodal diffusion transformer architecture',
    type: 'image',
    ecosystemId: ECO.SD3,
    hidden: true,
    disabled: true,
    licenseId: 9,
  },
  {
    id: BM.SD35Large,
    name: 'SD 3.5 Large',
    description: 'Multimodal diffusion transformer architecture',
    type: 'image',
    ecosystemId: ECO.SD3,
    hidden: true,
    disabled: true,
    licenseId: 9,
  },
  {
    id: BM.SD35LargeTurbo,
    name: 'SD 3.5 Large Turbo',
    description: 'Multimodal diffusion transformer architecture with turbo optimization',
    type: 'image',
    ecosystemId: ECO.SD3,
    hidden: true,
    disabled: true,
    licenseId: 9,
  },
  {
    id: BM.SD35Medium,
    name: 'SD 3.5 Medium',
    description: 'Balanced SD3.5 variant optimized for quality and speed',
    type: 'image',
    ecosystemId: ECO.SD35M,
    hidden: true,
    disabled: true,
    licenseId: 9,
  },

  // SDXL
  {
    id: BM.SDXL09,
    name: 'SDXL 0.9',
    description: 'High-resolution SD with improved prompt understanding and detail',
    type: 'image',
    ecosystemId: ECO.SDXL,
    hidden: true,
    licenseId: 2,
  },
  {
    id: BM.SDXL10,
    name: 'SDXL 1.0',
    description: 'High-resolution SD with improved prompt understanding and detail',
    type: 'image',
    ecosystemId: ECO.SDXL,
    licenseId: 3,
  },
  {
    id: BM.SDXL10LCM,
    name: 'SDXL 1.0 LCM',
    description: 'SDXL with Latent Consistency Model for faster inference',
    type: 'image',
    ecosystemId: ECO.SDXL,
    hidden: true,
    licenseId: 3,
  },
  {
    id: BM.SDXLLightning,
    name: 'SDXL Lightning',
    description: 'SDXL with Lightning optimization for reduced steps',
    type: 'image',
    ecosystemId: ECO.SDXL,
    licenseId: 3,
  },
  {
    id: BM.SDXLHyper,
    name: 'SDXL Hyper',
    description: 'SDXL with Hyper optimization for reduced steps',
    type: 'image',
    ecosystemId: ECO.SDXL,
    licenseId: 3,
  },
  {
    id: BM.SDXLTurbo,
    name: 'SDXL Turbo',
    description: 'SDXL with Turbo optimization for minimal steps',
    type: 'image',
    ecosystemId: ECO.SDXL,
    hidden: true,
    disabled: true,
    licenseId: 4,
  },
  {
    id: BM.SDXLDistilled,
    name: 'SDXL Distilled',
    description: 'Faster SDXL variants with reduced inference steps',
    type: 'image',
    ecosystemId: ECO.SDXLDistilled,
    hidden: true,
    licenseId: 3,
  },

  // Seedream
  {
    id: BM.Seedream,
    name: 'Seedream',
    description: "ByteDance's image generation model",
    type: 'image',
    ecosystemId: ECO.Seedream,
    hidden: true,
    licenseId: 23,
  },

  // SVD - fully disabled (no support for any type)
  {
    id: BM.SVD,
    name: 'SVD',
    description: 'Image-to-video diffusion model',
    type: 'image',
    ecosystemId: ECO.SVD,
    hidden: true,
    disabled: true,
    licenseId: 5,
  },
  {
    id: BM.SVDXT,
    name: 'SVD XT',
    description: 'Extended SVD for longer video generation',
    type: 'image',
    ecosystemId: ECO.SVD,
    hidden: true,
    disabled: true,
    licenseId: 5,
  },

  // Sora 2
  {
    id: BM.Sora2,
    name: 'Sora 2',
    description: 'Advanced video generation model',
    type: 'video',
    ecosystemId: ECO.Sora2,
    hidden: true,
    licenseId: 20,
  },

  // Veo 3
  {
    id: BM.Veo3,
    name: 'Veo 3',
    description: 'Latest video generation model from DeepMind',
    type: 'video',
    ecosystemId: ECO.Veo3,
    hidden: true,
    licenseId: 22,
  },

  // Wan Video
  {
    id: BM.WanVideo,
    name: 'Wan Video',
    description: 'Base video generation model',
    type: 'video',
    ecosystemId: ECO.WanVideo,
    hidden: true,
    licenseId: 13,
  },
  {
    id: BM.WanVideo13BT2V,
    name: 'Wan Video 1.3B t2v',
    description: 'Lightweight text-to-video model',
    type: 'video',
    ecosystemId: ECO.WanVideo1_3B_T2V,
    licenseId: 13,
  },
  {
    id: BM.WanVideo14BT2V,
    name: 'Wan Video 14B t2v',
    description: 'Full-scale text-to-video model',
    type: 'video',
    ecosystemId: ECO.WanVideo14B_T2V,
    licenseId: 13,
  },
  {
    id: BM.WanVideo14BI2V480p,
    name: 'Wan Video 14B i2v 480p',
    description: 'Image-to-video at 480p resolution',
    type: 'video',
    ecosystemId: ECO.WanVideo14B_I2V_480p,
    licenseId: 13,
  },
  {
    id: BM.WanVideo14BI2V720p,
    name: 'Wan Video 14B i2v 720p',
    description: 'Image-to-video at 720p resolution',
    type: 'video',
    ecosystemId: ECO.WanVideo14B_I2V_720p,
    licenseId: 13,
  },
  {
    id: BM.WanVideo22TI2V5B,
    name: 'Wan Video 2.2 TI2V-5B',
    description: 'Text/image-to-video 5B parameter model',
    type: 'video',
    ecosystemId: ECO.WanVideo22_TI2V_5B,
    licenseId: 13,
  },
  {
    id: BM.WanVideo22I2VA14B,
    name: 'Wan Video 2.2 I2V-A14B',
    description: 'Image-to-video 14B parameter model',
    type: 'video',
    ecosystemId: ECO.WanVideo22_I2V_A14B,
    licenseId: 13,
  },
  {
    id: BM.WanVideo22T2VA14B,
    name: 'Wan Video 2.2 T2V-A14B',
    description: 'Text-to-video 14B parameter model',
    type: 'video',
    ecosystemId: ECO.WanVideo22_T2V_A14B,
    licenseId: 13,
  },
  {
    id: BM.WanVideo25T2V,
    name: 'Wan Video 2.5 T2V',
    description: 'Latest text-to-video generation',
    type: 'video',
    ecosystemId: ECO.WanVideo25_T2V,
    licenseId: 13,
  },
  {
    id: BM.WanVideo25I2V,
    name: 'Wan Video 2.5 I2V',
    description: 'Latest image-to-video generation',
    type: 'video',
    ecosystemId: ECO.WanVideo25_I2V,
    licenseId: 13,
  },

  // ZImageTurbo
  {
    id: BM.ZImageTurbo,
    name: 'ZImageTurbo',
    description: 'Fast turbo-optimized image generation model',
    type: 'image',
    ecosystemId: ECO.ZImageTurbo,
    licenseId: 13,
  },

  // Vidu Q1
  {
    id: BM.Vidu,
    name: 'Vidu Q1',
    description: 'High-quality video generation model from Vidu',
    type: 'video',
    ecosystemId: ECO.Vidu,
    hidden: true,
    licenseId: 22,
  },

  // Hailuo by MiniMax
  {
    id: BM.MiniMax,
    name: 'Hailuo by MiniMax',
    description: "MiniMax's video generation model with cinematic quality",
    type: 'video',
    ecosystemId: ECO.MiniMax,
    hidden: true,
    licenseId: 22,
  },

  // Kling
  {
    id: BM.Kling,
    name: 'Kling',
    description: "Kuaishou's video generation model",
    type: 'video',
    ecosystemId: ECO.Kling,
    hidden: true,
    licenseId: 22,
  },
];

export const baseModelById = new Map(baseModels.map((m) => [m.id, m]));
export const baseModelByName = new Map(baseModels.map((m) => [m.name, m]));

// =============================================================================
// Derivation Functions
// =============================================================================

/**
 * Get the root ecosystem for an ecosystem (follows parent chain)
 */
export function getRootEcosystem(ecosystemId: number): EcosystemRecord {
  const ecosystem = ecosystemById.get(ecosystemId);
  if (!ecosystem) throw new Error(`Ecosystem ${ecosystemId} not found`);

  if (ecosystem.parentEcosystemId) {
    return getRootEcosystem(ecosystem.parentEcosystemId);
  }
  return ecosystem;
}

/**
 * Check if two ecosystems are in the same family tree
 */
export function areEcosystemsRelated(ecosystemId1: number, ecosystemId2: number): boolean {
  const root1 = getRootEcosystem(ecosystemId1);
  const root2 = getRootEcosystem(ecosystemId2);
  return root1.id === root2.id;
}

/**
 * Get ecosystem support, with inheritance from parent
 */
export function getEcosystemSupport(
  ecosystemId: number,
  supportType: SupportType
): EcosystemSupport | undefined {
  // Check for explicit entry
  const explicit = ecosystemSupport.find(
    (s) => s.ecosystemId === ecosystemId && s.supportType === supportType
  );
  if (explicit) return explicit;

  // Check parent ecosystem
  const ecosystem = ecosystemById.get(ecosystemId);
  if (ecosystem?.parentEcosystemId) {
    return getEcosystemSupport(ecosystem.parentEcosystemId, supportType);
  }

  return undefined;
}

/**
 * Get ecosystem setting, with inheritance from parent
 */
export function getEcosystemSetting<K extends keyof NonNullable<EcosystemSettings['defaults']>>(
  ecosystemId: number,
  key: K
): NonNullable<EcosystemSettings['defaults']>[K] | undefined {
  const settings = ecosystemSettings.find((s) => s.ecosystemId === ecosystemId);

  if (settings?.defaults?.[key] !== undefined) {
    return settings.defaults[key];
  }

  // Inherit from parent
  const ecosystem = ecosystemById.get(ecosystemId);
  if (ecosystem?.parentEcosystemId) {
    return getEcosystemSetting(ecosystem.parentEcosystemId, key);
  }

  return undefined;
}

/**
 * Check if a model is supported for a given support type
 */
export function isModelSupported(
  baseModelId: number,
  supportType: SupportType,
  modelType?: ModelType
): boolean {
  const baseModel = baseModelById.get(baseModelId);
  if (!baseModel) return false;

  // Check if model is entirely disabled (root-level disable)
  if (baseModel.disabled) return false;

  // Check model-level override
  const modelOverride = supportOverrides.find(
    (o) => o.baseModelId === baseModelId && o.supportType === supportType
  );
  if (modelOverride !== undefined) {
    if (modelOverride.disabled) return false;
    if (modelType && modelOverride.modelTypes && !modelOverride.modelTypes.includes(modelType)) {
      return false;
    }
  }

  // Check ecosystem-level override
  const ecosystemOverride = supportOverrides.find(
    (o) =>
      o.ecosystemId === baseModel.ecosystemId && !o.baseModelId && o.supportType === supportType
  );
  if (ecosystemOverride !== undefined) {
    if (ecosystemOverride.disabled) return false;
  }

  // Check ecosystem support
  const support = getEcosystemSupport(baseModel.ecosystemId, supportType);
  if (!support || support.disabled) return false;

  if (modelType && !support.modelTypes.includes(modelType)) {
    return false;
  }

  return true;
}

/**
 * Get generation support level between two ecosystems
 */
export function getGenerationSupport(
  checkpointEcosystemId: number,
  addonEcosystemId: number,
  addonModelType: ModelType
): SupportLevel | null {
  const checkpointEcosystem = ecosystemById.get(checkpointEcosystemId);
  const addonEcosystem = ecosystemById.get(addonEcosystemId);

  if (!checkpointEcosystem || !addonEcosystem) return null;

  // Check if model type is supported for generation
  const support = getEcosystemSupport(checkpointEcosystemId, 'generation');
  if (!support || support.disabled || !support.modelTypes.includes(addonModelType)) {
    return null;
  }

  // Same ecosystem = Full
  if (checkpointEcosystemId === addonEcosystemId) return 'full';

  // Check if related (parent/child/sibling)
  if (areEcosystemsRelated(checkpointEcosystemId, addonEcosystemId)) {
    return 'partial';
  }

  // Check cross-ecosystem rules
  const crossRule = crossEcosystemRules.find(
    (r) =>
      r.sourceEcosystemId === addonEcosystemId &&
      r.targetEcosystemId === checkpointEcosystemId &&
      r.supportType === 'generation' &&
      (!r.modelTypes || r.modelTypes.includes(addonModelType))
  );

  // Also check if the target is a child of the rule's target
  if (!crossRule) {
    const targetRoot = getRootEcosystem(checkpointEcosystemId);
    const matchingRule = crossEcosystemRules.find(
      (r) =>
        r.sourceEcosystemId === addonEcosystemId &&
        r.targetEcosystemId === targetRoot.id &&
        r.supportType === 'generation' &&
        (!r.modelTypes || r.modelTypes.includes(addonModelType))
    );
    if (matchingRule) return matchingRule.support;
  }

  if (crossRule) return crossRule.support;

  return null;
}

/**
 * Get the ecosystem for a base model
 */
export function getBaseModelEcosystem(baseModelId: number): EcosystemRecord | undefined {
  const model = baseModelById.get(baseModelId);
  if (!model) return undefined;

  return ecosystemById.get(model.ecosystemId);
}

/**
 * Get base models for an ecosystem (including children)
 */
export function getBaseModelsByEcosystemId(
  ecosystemId: number,
  includeChildren = true
): BaseModelRecord[] {
  const ecosystemIds = new Set([ecosystemId]);

  if (includeChildren) {
    // Find all child ecosystems
    for (const eco of ecosystems) {
      if (eco.parentEcosystemId === ecosystemId) {
        ecosystemIds.add(eco.id);
      }
    }
  }

  // Find all base models in these ecosystems
  return baseModels.filter((m) => ecosystemIds.has(m.ecosystemId));
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
 * Get family for an ecosystem
 */
export function getEcosystemFamily(ecosystemId: number): BaseModelFamilyRecord | undefined {
  const ecosystem = ecosystemById.get(ecosystemId);
  if (!ecosystem?.familyId) return undefined;
  return ecosystemFamilyById.get(ecosystem.familyId);
}

/**
 * Get default model ID for an ecosystem
 */
export function getDefaultModelId(ecosystemId: number): number | undefined {
  const model = getEcosystemSetting(ecosystemId, 'model');
  return model?.id;
}

/**
 * Get default engine for an ecosystem
 */
export function getDefaultEngine(ecosystemId: number): string | undefined {
  return getEcosystemSetting(ecosystemId, 'engine');
}

/**
 * Map of generation mode to workflow keys that produce that mode.
 * Derived from workflow definitions.
 */
const modeToWorkflows = new Map<GenerationMode, string[]>([
  [
    'txt2img',
    workflows.filter((w) => w.inputType === 'text' && w.outputType !== 'video').map((w) => w.key),
  ],
  [
    'img2img',
    workflows.filter((w) => w.inputType === 'image' && w.outputType !== 'video').map((w) => w.key),
  ],
  [
    'txt2vid',
    workflows.filter((w) => w.inputType === 'text' && w.outputType === 'video').map((w) => w.key),
  ],
  [
    'img2vid',
    workflows.filter((w) => w.inputType === 'image' && w.outputType === 'video').map((w) => w.key),
  ],
  ['vid2vid', workflows.filter((w) => w.inputType === 'video').map((w) => w.key)],
]);

/**
 * Get available generation modes for an ecosystem.
 * Derives modes from workflow ecosystem IDs.
 */
export function getAvailableGenerationModes(ecosystemId: number): GenerationMode[] {
  const modes: GenerationMode[] = [];
  for (const [mode, workflowKeys] of modeToWorkflows) {
    // Check if any workflow of this mode includes this ecosystem
    const hasMode = workflowKeys.some((key) => {
      const workflow = workflowByKey.get(key);
      return workflow?.ecosystemIds.includes(ecosystemId);
    });
    if (hasMode) modes.push(mode);
  }
  return modes;
}

/**
 * Check if an ecosystem supports a specific generation mode.
 */
export function supportsGenerationMode(ecosystemId: number, mode: GenerationMode): boolean {
  const workflowKeys = modeToWorkflows.get(mode) ?? [];
  return workflowKeys.some((key) => {
    const workflow = workflowByKey.get(key);
    return workflow?.ecosystemIds.includes(ecosystemId);
  });
}

/**
 * Get generation modes for an ecosystem key.
 * Convenience function that looks up by ecosystem key string.
 */
export function getGenerationModesForEcosystemKey(ecosystemKey: string): GenerationMode[] {
  const ecosystem = ecosystemByKey.get(ecosystemKey);
  if (!ecosystem) return [];
  return getAvailableGenerationModes(ecosystem.id);
}

/**
 * Get ecosystem keys that support a specific generation mode.
 * Filters ecosystems to only those that support the given mode (e.g., 'img2img').
 */
export function getEcosystemsForGenerationMode(mode: GenerationMode): string[] {
  const workflowKeys = modeToWorkflows.get(mode) ?? [];
  const ecosystemIds = new Set<number>();
  for (const key of workflowKeys) {
    const workflow = workflowByKey.get(key);
    if (workflow) {
      for (const id of workflow.ecosystemIds) {
        ecosystemIds.add(id);
      }
    }
  }
  return [...ecosystemIds]
    .map((id) => ecosystemById.get(id)?.key)
    .filter((key): key is string => !!key)
    .sort((a, b) => {
      const ecoA = ecosystemByKey.get(a);
      const ecoB = ecosystemByKey.get(b);
      return (ecoA?.sortOrder ?? 999) - (ecoB?.sortOrder ?? 999);
    });
}

// =============================================================================
// Workflow Helpers
// =============================================================================

/**
 * Get workflow record by key.
 */
export function getWorkflow(workflowKey: string): WorkflowRecord | undefined {
  return workflowByKey.get(workflowKey);
}

/**
 * Get available workflows for an ecosystem.
 * Returns workflow records where the ecosystem ID is in the workflow's ecosystemIds list.
 */
export function getAvailableWorkflows(ecosystemId: number): WorkflowRecord[] {
  return workflows.filter((w) => w.ecosystemIds.includes(ecosystemId));
}

/**
 * Check if an ecosystem supports a specific workflow.
 */
export function supportsWorkflow(ecosystemId: number, workflowKey: string): boolean {
  const workflow = workflowByKey.get(workflowKey);
  return workflow?.ecosystemIds.includes(ecosystemId) ?? false;
}

/**
 * Get ecosystem keys that support a specific workflow.
 */
export function getEcosystemsForWorkflow(workflowKey: string): string[] {
  const workflow = workflowByKey.get(workflowKey);
  if (!workflow) return [];

  return workflow.ecosystemIds
    .map((id) => ecosystemById.get(id)?.key)
    .filter((key): key is string => !!key)
    .sort((a, b) => {
      const ecoA = ecosystemByKey.get(a);
      const ecoB = ecosystemByKey.get(b);
      return (ecoA?.sortOrder ?? 999) - (ecoB?.sortOrder ?? 999);
    });
}

/**
 * Get base models available for generation (not hidden, not disabled, has generation support)
 */
export function getGenerationBaseModels(): BaseModelRecord[] {
  return baseModels.filter((m) => {
    if (m.hidden || m.disabled) return false;
    return isModelSupported(m.id, 'generation');
  });
}

/**
 * Get base models available for training
 */
export function getTrainingBaseModels(): BaseModelRecord[] {
  return baseModels.filter((m) => {
    if (m.hidden || m.disabled) return false;
    return isModelSupported(m.id, 'training');
  });
}

/**
 * Get disabled base models
 */
export function getDisabledBaseModels(): BaseModelRecord[] {
  return baseModels.filter((m) => m.disabled);
}

/**
 * Get ecosystems for a family
 */
export function getEcosystemsByFamilyId(familyId: number): EcosystemRecord[] {
  return ecosystems.filter((e) => e.familyId === familyId);
}

// =============================================================================
// Ecosystems by Media Type
// =============================================================================

/**
 * Get ecosystem keys that support generation for a given media type.
 * Derived from base models and their ecosystem support.
 */
export function getGenerationEcosystemsForMediaType(mediaType: MediaType): string[] {
  // Get all base models that support generation and match the media type
  const validModels = baseModels.filter((m) => {
    if (m.disabled) return false;
    if (m.type !== mediaType) return false;
    // Check if ecosystem supports generation
    const support = getEcosystemSupport(m.ecosystemId, 'generation');
    return support && !support.disabled;
  });

  // Get unique ecosystem IDs from those models
  const ecosystemIds = new Set(validModels.map((m) => m.ecosystemId));

  // Return ecosystem keys sorted by sortOrder
  return ecosystems
    .filter((e) => ecosystemIds.has(e.id))
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
    .map((e) => e.key);
}

/**
 * Get the default ecosystem key for a media type.
 * Returns the first ecosystem (by sortOrder) that supports generation for this media type.
 */
export function getDefaultEcosystemForMediaType(mediaType: MediaType): string | undefined {
  const ecosystemKeys = getGenerationEcosystemsForMediaType(mediaType);
  return ecosystemKeys[0];
}

/**
 * Get base models available for auction
 */
export function getAuctionBaseModels(): BaseModelRecord[] {
  return baseModels.filter((m) => {
    if (m.hidden || m.disabled) return false;
    return isModelSupported(m.id, 'auction');
  });
}

/**
 * Get base models by ecosystem name (lowercase ecosystem name)
 */
export function getBaseModelsByEcosystemName(ecosystemName: string): BaseModelRecord[] {
  const ecosystem = ecosystemByName.get(ecosystemName);
  if (!ecosystem) return [];
  return getBaseModelsByEcosystemId(ecosystem.id);
}

/**
 * Get compatible base models for an ecosystem and model type
 * Returns base models that can be used with the given ecosystem, split by support level
 */
export function getCompatibleBaseModels(
  ecosystemId: number,
  modelType: ModelType
): { full: BaseModelRecord[]; partial: BaseModelRecord[] } {
  const full: BaseModelRecord[] = [];
  const partial: BaseModelRecord[] = [];

  for (const model of baseModels) {
    if (model.disabled) continue;

    const modelEcosystem = ecosystemById.get(model.ecosystemId);
    if (!modelEcosystem) continue;

    // Check if this model's ecosystem supports the model type for generation
    const support = getEcosystemSupport(model.ecosystemId, 'generation');
    if (!support || support.disabled || !support.modelTypes.includes(modelType)) continue;

    // Get support level
    const supportLevel = getGenerationSupport(ecosystemId, model.ecosystemId, modelType);

    if (supportLevel === 'full') {
      full.push(model);
    } else if (supportLevel === 'partial') {
      partial.push(model);
    }
  }

  return { full, partial };
}

// =============================================================================
// Generation Compatibility Check
// =============================================================================

/**
 * Result for a single base model's compatibility check
 */
export type BaseModelCompatibilityStatus = {
  baseModel: string;
  support: SupportLevel | null; // null means not compatible
};

/**
 * An ecosystem that supports one or more of the requested base models
 */
export type CompatibleEcosystemResult = {
  ecosystemId: number;
  ecosystemName: string;
  ecosystemKey: string;
  baseModels: BaseModelCompatibilityStatus[];
};

/**
 * Result of checking base model compatibility for generation
 */
export type GenerationCompatibilityResult = {
  /** The primary base model used to determine the generation ecosystem */
  primaryBaseModel: string;
  /** The ecosystem determined by the primary base model */
  primaryEcosystem: { id: number; name: string; key: string } | null;
  /** Whether all requested base models are compatible with the primary ecosystem */
  allCompatible: boolean;
  /** Compatibility status for each requested base model within the primary ecosystem */
  compatibility: BaseModelCompatibilityStatus[];
  /** List of incompatible base models (those with null support) */
  incompatible: string[];
  /** Alternative ecosystems that support one or more of the incompatible base models */
  alternativeEcosystems: CompatibleEcosystemResult[];
};

/**
 * Check generation compatibility for a set of base models against a primary base model or ecosystem.
 *
 * Given a primary base model name or ecosystem key (e.g., the checkpoint being used for generation)
 * and a list of additional base model names (e.g., LoRAs, embeddings), this function determines:
 * - Which base models are compatible with the primary model's ecosystem
 * - Which are incompatible
 * - What alternative ecosystems could support the incompatible base models
 *
 * @param baseModelOrEcosystem - The name of a base model (e.g., "SDXL 1.0") or ecosystem key (e.g., "SDXL")
 * @param baseModelNames - Array of base model names to check compatibility for
 * @returns Compatibility result with status for each base model and alternative ecosystems
 *
 * @example
 * ```ts
 * // Using a base model name
 * const result = checkGenerationCompatibility('SDXL 1.0', ['Pony', 'SD 1.5', 'Flux.1 D']);
 *
 * // Using an ecosystem key
 * const result = checkGenerationCompatibility('SDXL', ['Pony', 'SD 1.5', 'Flux.1 D']);
 *
 * // result.allCompatible = false
 * // result.compatibility = [
 * //   { baseModel: 'Pony', support: 'partial' },
 * //   { baseModel: 'SD 1.5', support: null },
 * //   { baseModel: 'Flux.1 D', support: null }
 * // ]
 * // result.incompatible = ['SD 1.5', 'Flux.1 D']
 * // result.alternativeEcosystems = [ecosystems that support SD 1.5 or Flux.1 D]
 * ```
 */
export function checkGenerationCompatibility(
  baseModelOrEcosystem: string,
  baseModelNames: string[]
): GenerationCompatibilityResult {
  // Try to find as a base model first, then as an ecosystem
  const primaryAsBaseModel = baseModelByName.get(baseModelOrEcosystem);
  const primaryAsEcosystem = ecosystemByKey.get(baseModelOrEcosystem);

  let primaryEcosystem: EcosystemRecord | undefined;

  if (primaryAsBaseModel) {
    // Found as a base model, get its ecosystem
    primaryEcosystem = ecosystemById.get(primaryAsBaseModel.ecosystemId);
  } else if (primaryAsEcosystem) {
    // Found as an ecosystem directly
    primaryEcosystem = primaryAsEcosystem;
  }

  if (!primaryEcosystem) {
    return {
      primaryBaseModel: baseModelOrEcosystem,
      primaryEcosystem: null,
      allCompatible: false,
      compatibility: baseModelNames.map((name) => ({ baseModel: name, support: null })),
      incompatible: baseModelNames,
      alternativeEcosystems: [],
    };
  }

  // Check each base model's compatibility
  const compatibility: BaseModelCompatibilityStatus[] = baseModelNames.map((name) => {
    const bm = baseModelByName.get(name);
    if (!bm) {
      return { baseModel: name, support: null };
    }

    // Get support level for this base model in the primary ecosystem
    // We need to check what model type this is - assume LORA for addons
    const support = getGenerationSupport(primaryEcosystem!.id, bm.ecosystemId, ModelType.LORA);
    return {
      baseModel: name,
      support,
    };
  });

  // Find incompatible base models
  const incompatible = compatibility.filter((c) => c.support === null).map((c) => c.baseModel);

  // Find alternative ecosystems for incompatible base models
  const alternativeEcosystems: CompatibleEcosystemResult[] = [];

  if (incompatible.length > 0) {
    // Get all ecosystems that have generation support
    const ecosystemsWithSupport = new Set(
      ecosystemSupport
        .filter((s) => s.supportType === 'generation' && !s.disabled)
        .map((s) => s.ecosystemId)
    );

    for (const ecoId of ecosystemsWithSupport) {
      // Skip the primary ecosystem
      if (ecoId === primaryEcosystem.id) continue;

      const eco = ecosystemById.get(ecoId);
      if (!eco) continue;

      // Check which incompatible base models this ecosystem supports
      const ecoBaseModels: BaseModelCompatibilityStatus[] = [];

      for (const bmName of incompatible) {
        const bm = baseModelByName.get(bmName);
        if (!bm) continue;

        const support = getGenerationSupport(ecoId, bm.ecosystemId, ModelType.LORA);
        if (support) {
          ecoBaseModels.push({
            baseModel: bmName,
            support,
          });
        }
      }

      // Only include ecosystems that support at least one incompatible base model
      if (ecoBaseModels.length > 0) {
        alternativeEcosystems.push({
          ecosystemId: eco.id,
          ecosystemName: eco.name,
          ecosystemKey: eco.key,
          baseModels: ecoBaseModels,
        });
      }
    }

    // Sort alternative ecosystems by number of supported base models (descending)
    alternativeEcosystems.sort((a, b) => b.baseModels.length - a.baseModels.length);
  }

  return {
    primaryBaseModel: baseModelOrEcosystem,
    primaryEcosystem: {
      id: primaryEcosystem.id,
      name: primaryEcosystem.name,
      key: primaryEcosystem.key,
    },
    allCompatible: incompatible.length === 0,
    compatibility,
    incompatible,
    alternativeEcosystems,
  };
}
