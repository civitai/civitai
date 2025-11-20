import { ReviewReactions } from '~/shared/utils/prisma/enums';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import type { GenerationResource } from '~/server/common/types/generation.types';
import { GENERATION_MAX_VALUES } from '~/server/schema/generation.constants';

export const samplers = [
  'Euler a',
  'Euler',
  'LMS',
  'Heun',
  'DPM2',
  'DPM2 a',
  'DPM++ 2S a',
  'DPM++ 2M',
  'DPM++ SDE',
  'DPM++ 2M SDE',
  'DPM++ 3M SDE',
  'DPM fast',
  'DPM adaptive',
  'LMS Karras',
  'DPM2 Karras',
  'DPM2 a Karras',
  'DPM++ 2S a Karras',
  'DPM++ 2M Karras',
  'DPM++ SDE Karras',
  'DPM++ 2M SDE Karras',
  'DPM++ 3M SDE Karras',
  'DPM++ 3M SDE Exponential',
  'DDIM',
  'PLMS',
  'UniPC',
  'LCM',
] as const;

export type Sampler = (typeof samplers)[number];

export const samplerMap = new Map<Sampler, string[]>([
  ['Euler a', ['euler_ancestral']],
  ['Euler', ['euler']],
  ['LMS', ['lms']],
  ['Heun', ['heun']],
  ['DPM2', ['dpm_2']],
  ['DPM2 a', ['dpm_2_ancestral']],
  ['DPM++ 2S a', ['dpmpp_2s_ancestral']],
  ['DPM++ 2M', ['dpmpp_2m']],
  ['DPM++ SDE', ['dpmpp_sde', 'dpmpp_sde_gpu']],
  ['DPM++ 2M SDE', ['dpmpp_2m_sde']],
  ['DPM fast', ['dpm_fast']],
  ['DPM adaptive', ['dpm_adaptive']],
  ['LMS Karras', ['lms_karras']],
  ['DPM2 Karras', ['dpm_2_karras']],
  ['DPM2 a Karras', ['dpm_2_ancestral_karras']],
  ['DPM++ 2S a Karras', ['dpmpp_2s_ancestral_karras']],
  ['DPM++ 2M Karras', ['dpmpp_2m_karras']],
  ['DPM++ SDE Karras', ['dpmpp_sde_karras']],
  ['DPM++ 2M SDE Karras', ['dpmpp_2m_sde_karras']],
  ['DDIM', ['ddim']],
  ['PLMS', ['plms']],
  ['UniPC', ['uni_pc', 'uni_pc_bh2']],
  ['LCM', ['lcm']],
]);

export const samplerOffsets = {
  'Euler a': 4,
  Euler: 4,
  Heun: 8,
  LMS: 10,
  DDIM: 15,
  'DPM++ 2M Karras': 4,
  DPM2: 4,
  'DPM2 a': 4,
  undefined: 4,
} as const;

const commonAspectRatios = [
  { label: 'Square', width: 1024, height: 1024 },
  { label: 'Landscape', width: 1216, height: 832 },
  { label: 'Portrait', width: 832, height: 1216 },
];

export const seedreamSizes = [
  { label: '16:9', width: 2560, height: 1440 },
  { label: '4:3', width: 2304, height: 1728 },
  { label: '1:1', width: 2048, height: 2048 },
  { label: '3:4', width: 1728, height: 2304 },
  { label: '9:16', width: 1440, height: 2560 },
];

export const qwenSizes = [
  { label: '16:9', width: 1664, height: 928 },
  { label: '4:3', width: 1472, height: 1140 },
  { label: '1:1', width: 1328, height: 1328 },
  { label: '3:4', width: 1140, height: 1472 },
  { label: '9:16', width: 928, height: 1664 },
];

export const ponyV7Sizes = [
  { label: '3:2', width: 1536, height: 1024 },
  { label: '6:5', width: 1536, height: 1280 },
  { label: '1:1', width: 1536, height: 1536 },
  { label: '5:6', width: 1280, height: 1536 },
  { label: '2:3', width: 1024, height: 1536 },
];

export const generationConfig = {
  SD1: {
    aspectRatios: [
      { label: 'Square', width: 512, height: 512 },
      { label: 'Landscape', width: 768, height: 512 },
      { label: 'Portrait', width: 512, height: 768 },
    ],
    checkpoint: {
      id: 128713,
      name: '8',
      trainedWords: [],
      baseModel: 'SD 1.5',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 4384,
        name: 'DreamShaper',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  SDXL: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 128078,
      name: 'v1.0 VAE fix',
      trainedWords: [],
      baseModel: 'SDXL 1.0',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 101055,
        name: 'SD XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Pony: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 290640,
      name: 'V6 (start with this one)',
      trainedWords: [],
      baseModel: 'Pony',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 257749,
        name: 'Pony Diffusion V6 XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  PonyV7: {
    aspectRatios: ponyV7Sizes,
    checkpoint: {
      id: 2152373,
      name: 'v7.0',
      trainedWords: [],
      baseModel: 'PonyV7',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1901521,
        name: 'Pony V7',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Illustrious: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 889818,
      name: 'v0.1',
      trainedWords: [],
      baseModel: 'Illustrious',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 795765,
        name: 'Illustrious-XL',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Chroma: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2164239,
      name: 'v1.0-HD',
      trainedWords: [],
      baseModel: 'Chroma',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1330309,
        name: 'Chroma',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  NoobAI: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 1190596,
      name: 'V-Pred-1.0-Version',
      trainedWords: [],
      baseModel: 'NoobAI',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 833294,
        name: 'NoobAI-XL (NAI-XL)',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Flux1: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 691639,
      name: '',
      trainedWords: [],
      baseModel: 'Flux.1 D',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 618692,
        name: 'FLUX',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  FluxKrea: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2068000,
      name: '',
      trainedWords: [],
      baseModel: 'Flux.1 Krea',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 618692,
        name: 'FLUX',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Qwen: {
    aspectRatios: qwenSizes,
    checkpoint: {
      id: 2113658,
      name: 'Qwen-Image Full BF16',
      trainedWords: [],
      baseModel: 'Qwen',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1864281,
        name: 'Qwen-Image',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Seedream: {
    aspectRatios: seedreamSizes,
    checkpoint: {
      id: 2208278,
      name: 'v4.0',
      trainedWords: [],
      baseModel: 'Seedream',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1951069,
        name: 'Seedream',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  HiDream: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 1771369,
      name: '',
      trainedWords: [],
      baseModel: 'HiDream',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      covered: true,
      model: {
        id: 1562709,
        name: 'HiDream',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  Flux1Kontext: {
    aspectRatios: [
      { label: '21:9', width: 21, height: 9 },
      { label: '16:9', width: 16, height: 9 },
      { label: '4:3', width: 4, height: 3 },
      { label: '3:2', width: 3, height: 2 },
      { label: '1:1', width: 1, height: 1 },
      { label: '2:3', width: 2, height: 3 },
      { label: '3:4', width: 3, height: 4 },
      { label: '9:16', width: 9, height: 16 },
      { label: '9:21', width: 9, height: 21 },
    ],
    checkpoint: {
      id: 1892509,
      name: 'Flux.1 Kontext [Pro]',
      trainedWords: [],
      baseModel: 'Flux.1 Kontext',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1672021,
        name: 'FLUX.1 Kontext',
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  OpenAI: {
    aspectRatios: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1536, height: 1024 },
      { label: 'Portrait', width: 1024, height: 1536 },
    ],
    checkpoint: {
      id: 1733399,
      name: '4o Image Gen 1',
      trainedWords: [],
      baseModel: 'OpenAI',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1532032,
        name: `OpenAI's GPT-image-1`,
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },

  Imagen4: {
    aspectRatios: [
      { label: '16:9', width: 16, height: 9 },
      { label: '4:3', width: 4, height: 3 },
      { label: '1:1', width: 1, height: 1 },
      { label: '3:4', width: 3, height: 4 },
      { label: '9:16', width: 9, height: 16 },
    ],
    checkpoint: {
      id: 1889632,
      name: 'Imagen 4',
      trainedWords: [],
      baseModel: 'Imagen4',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1669468,
        name: `Google Imagen 4`,
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },
  NanoBanana: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 2154472,
      name: 'Nano Banana',
      trainedWords: [],
      baseModel: 'NanoBanana',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 1903424,
        name: `Google Nano Banana`,
        type: 'Checkpoint',
      },
    } as GenerationResource,
  },

  Other: {
    aspectRatios: commonAspectRatios,
    checkpoint: {
      id: 164821,
      name: '',
      trainedWords: [],
      baseModel: 'Other',
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      canGenerate: true,
      hasAccess: true,
      model: {
        id: 147759,
        name: 'Remacri',
        type: 'Upscaler',
      },
    } as GenerationResource,
  },
};

export const generation = {
  formStoreKey: 'generation-form',
  samplers: Object.keys(samplerOffsets) as (keyof typeof samplerOffsets)[],
  lcmSamplers: ['LCM', 'Euler a'] as Sampler[],
  defaultValues: {
    workflow: 'txt2img',
    cfgScale: 3.5,
    steps: 25,
    sampler: 'DPM++ 2M Karras',
    seed: null,
    clipSkip: 2,
    quantity: 2,
    aspectRatio: '1:1',
    prompt: '',
    negativePrompt: '',
    nsfw: false,
    baseModel: 'Flux1',
    denoise: 0.4,
    upscale: 1.5,
    civitaiTip: 0,
    creatorTip: 0.25,
    fluxUltraAspectRatio: '4',
    fluxMode: 'urn:air:flux1:checkpoint:civitai:618692@691639',
    fluxUltraRaw: false,
    model: generationConfig.Flux1.checkpoint,
    priority: 'low',
    sourceImage: null,
    openAIQuality: 'medium',
    vae: null,
    resources: null,
  },
  maxValues: GENERATION_MAX_VALUES,
} as const;

export const maxRandomSeed = 2147483647;
export const maxUpscaleSize = 3840;
export const minDownscaleSize = 320;
export const minUploadSize = 300;

export function getGenerationConfig(baseModel = 'SD1') {
  if (!(baseModel in generationConfig)) {
    return getGenerationConfig(); // fallback to default config
  }
  return generationConfig[baseModel as keyof typeof generationConfig];
}

export const imageGuard = {
  noAccountLimit: 5,
  cutoff: 1000 * 60 * 60 * 24,
};

export const imageGeneration = {
  drawerZIndex: 301,
  requestBlocking: {
    warned: 3,
    notified: 5,
    muted: 8,
  },
  epochGenerationTimeLimit: 15, // In days
};

export const availableReactions = {
  [ReviewReactions.Like]: '👍',
  [ReviewReactions.Dislike]: '👎',
  [ReviewReactions.Heart]: '❤️',
  [ReviewReactions.Laugh]: '😂',
  [ReviewReactions.Cry]: '😢',
};

export const richTextEditor = {
  maxFileSize: 1024 * 1024 * 5, // 5MB
  accept: [...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE],
  // Taken from https://v5.mantine.dev/others/tiptap/#text-color
  presetColors: [
    '#25262b',
    '#868e96',
    '#fa5252',
    '#e64980',
    '#be4bdb',
    '#7950f2',
    '#4c6ef5',
    '#228be6',
    '#15aabf',
    '#12b886',
    '#40c057',
    '#82c91e',
    '#fab005',
    '#fd7e14',
  ] as string[],
};

export const maxOrchestratorImageFileSize = 16 * 1024 ** 2; // 16MB
export const maxImageFileSize = 50 * 1024 ** 2; // 50MB
export const maxVideoFileSize = 750 * 1024 ** 2; // 750MB
export const maxVideoDimension = 3840;
export const maxVideoDurationSeconds = 245;

export const orchestratorUrls = [
  'https://orchestration.civitai.com',
  'https://orchestration-dev.civitai.com',
  'https://orchestration-stage.civitai.com',
];

export function isOrchestratorUrl(url: string) {
  return orchestratorUrls.some((orchestratorUrl) => url.startsWith(orchestratorUrl));
}
