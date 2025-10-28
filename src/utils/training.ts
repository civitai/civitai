import type JSZip from 'jszip';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { OrchEngineTypes, OrchPriorityTypes } from '~/server/common/enums';
import { getMimeTypeFromExt, MEDIA_TYPE } from '~/shared/constants/mime-types';
import type {
  TrainingDetailsBaseModelList,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { getFileExtension } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const trainingBaseModelTypesImage = ['sd15', 'sdxl', 'sd35', 'flux', 'chroma'] as const;
export const trainingBaseModelTypesVideo = ['hunyuan', 'wan'] as const;
export const trainingBaseModelType = [
  ...trainingBaseModelTypesImage,
  ...trainingBaseModelTypesVideo,
] as const;
export type TrainingBaseModelType = (typeof trainingBaseModelType)[number];

export const engineTypes = ['kohya', 'rapid', 'musubi', 'ai-toolkit'] as const;
export type EngineTypes = (typeof engineTypes)[number];

export const optimizerTypes = ['AdamW8Bit', 'Adafactor', 'Prodigy'] as const;
export type OptimizerTypes = (typeof optimizerTypes)[number];

export const loraTypes = ['lora'] as const; // LoCon Lycoris, LoHa Lycoris
export const lrSchedulerTypes = ['constant', 'cosine', 'cosine_with_restarts', 'linear'] as const;

export const trainingModelInfo: {
  [key in TrainingDetailsBaseModelList]: {
    label: string;
    pretty: string;
    type: TrainingBaseModelType;
    description: string;
    air: string;
    baseModel: BaseModel;
    isNew: boolean;
    disabled?: boolean;
  };
} = {
  sd_1_5: {
    label: 'Standard',
    pretty: 'SD 1.5',
    type: 'sd15',
    description: 'Useful for all purposes.',
    air: 'urn:air:sd1:checkpoint:civitai:127227@139180',
    baseModel: 'SD 1.5',
    isNew: false,
  },
  anime: {
    label: 'Anime',
    pretty: 'Anime',
    type: 'sd15',
    description: 'Results will have an anime aesthetic.',
    air: 'urn:air:sd1:checkpoint:civitai:84586@89927',
    baseModel: 'SD 1.5',
    isNew: false,
  },
  semi: {
    label: 'Semi-realistic',
    pretty: 'Semi Real',
    type: 'sd15',
    description: 'Results will be a blend of anime and realism.',
    air: 'urn:air:sd1:checkpoint:civitai:4384@128713',
    baseModel: 'SD 1.5',
    isNew: false,
  },
  realistic: {
    label: 'Realistic',
    pretty: 'Realistic',
    type: 'sd15',
    description: 'Results will be extremely realistic.',
    air: 'urn:air:sd1:checkpoint:civitai:81458@132760',
    baseModel: 'SD 1.5',
    isNew: false,
  },
  //
  sdxl: {
    label: 'Standard',
    pretty: 'SDXL',
    type: 'sdxl',
    description: 'Useful for all purposes, and uses SDXL.',
    air: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
    baseModel: 'SDXL 1.0',
    isNew: false,
  },
  pony: {
    label: 'Pony',
    pretty: 'Pony',
    type: 'sdxl',
    description: 'Tailored to visuals of various anthro, feral, or humanoid species.',
    air: 'urn:air:sdxl:checkpoint:civitai:257749@290640',
    baseModel: 'Pony',
    isNew: false,
  },
  illustrious: {
    label: 'Illustrious',
    pretty: 'Illustrious',
    type: 'sdxl',
    description: 'Optimized for illustration and animation.',
    air: 'urn:air:sdxl:checkpoint:civitai:795765@889818',
    baseModel: 'Illustrious',
    isNew: false,
  },
  //
  // sd3_medium: {
  //   label: 'Medium',
  //   pretty: 'SD 3.5 M',
  //   type: 'sd35',
  //   description: 'Designed for a balance of quality and efficiency.',
  //   air: 'urn:air:sd3:checkpoint:civitai:896953@1003708',
  //   baseModel: 'SD 3.5 Medium',
  //   isNew: false,
  // },
  // sd3_large: {
  //   label: 'Large',
  //   pretty: 'SD 3.5 L',
  //   type: 'sd35',
  //   description: 'Designed for high-quality images across diverse styles.',
  //   air: 'urn:air:sd3:checkpoint:civitai:878387@983309',
  //   baseModel: 'SD 3.5 Large',
  //   isNew: false,
  // },
  //
  flux_dev: {
    label: 'Dev',
    pretty: 'Flux',
    type: 'flux',
    description: 'High-quality images and accurate text.',
    air: 'urn:air:flux1:checkpoint:civitai:618692@691639',
    baseModel: 'Flux.1 D',
    isNew: false,
  },
  //
  hy_720_fp8: {
    label: '720p [fp8]',
    pretty: 'Hunyuan 720p [fp8]',
    type: 'hunyuan',
    description: 'Performant video generation.',
    // air: 'urn:air:hyv1:checkpoint:civitai:1167575@1314512',
    air: 'urn:air:hyv1:vae:huggingface:tencent/HunyuanVideo@main/hunyuan-video-t2v-720p/vae/pytorch_model.pt',
    baseModel: 'Hunyuan Video',
    isNew: false,
  },
  wan_2_1_t2v_14b: {
    label: '2.1 T2V [14B]',
    pretty: 'Wan 2.1 T2V [14B]',
    type: 'wan',
    description: 'Performant and high quality video generation (for T2V).',
    air: 'urn:air:wanvideo:vae:huggingface:Wan-AI/Wan2.1-I2V-14B-720P@main/Wan2.1_VAE.pth', // actually t2v, uses HF
    baseModel: 'Wan Video 14B t2v',
    isNew: false,
  },
  wan_2_1_i2v_14b_720p: {
    label: '2.1 I2V [14B, 720p]',
    pretty: 'Wan 2.1 I2V [14B, 720p]',
    type: 'wan',
    description: 'Performant and high quality video generation (for I2V).',
    air: 'urn:air:wanvideo:checkpoint:civitai:1329096@1501344',
    baseModel: 'Wan Video 14B i2v 720p',
    isNew: true,
    disabled: true, // TODO remove
  },
  //
  chroma: {
    label: '1.0 HD',
    pretty: 'Chroma',
    type: 'chroma',
    description: 'Open-Source, Uncensored, and Built for the Community',
    air: 'urn:air:chroma:checkpoint:civitai:1330309@2164239',
    baseModel: 'Chroma',
    isNew: false,
  },
};

export const rapidEta = 5;

export async function unzipTrainingData<T = void>(
  zData: JSZip,
  cb: (args: { imgBlob: Blob; filename: string; fileExt: string }) => Promise<T> | T
) {
  return (
    await Promise.all(
      Object.entries(zData.files).map(async ([zname, zf]) => {
        if (zf.dir) return;
        if (zname.startsWith('__MACOSX/') || zname.endsWith('.DS_STORE')) return;

        const fileExt = getFileExtension(zname);
        const mimeType = getMimeTypeFromExt(fileExt);
        if (!MEDIA_TYPE[mimeType as any]) return;
        const imgBlob = await zf.async('blob');
        return cb({ imgBlob, filename: zname, fileExt });
      })
    )
  ).filter(isDefined);
}

export const isValidRapid = (baseModel: TrainingBaseModelType, engine: EngineTypes) => {
  return baseModel === 'flux' && engine === 'rapid';
};

export const isInvalidRapid = (baseModel: TrainingBaseModelType, engine: EngineTypes) => {
  return baseModel !== 'flux' && engine === 'rapid';
};

export const getTrainingFields = {
  getModel: (model: string) => {
    return model in trainingModelInfo
      ? trainingModelInfo[model as keyof typeof trainingModelInfo].air
      : model;
  },
  getPriority: (isPriority: boolean) => {
    return isPriority ? OrchPriorityTypes.Normal : OrchPriorityTypes.Low;
  },
  getEngine: (engine: TrainingDetailsParams['engine']) => {
    return engine === 'rapid'
      ? OrchEngineTypes.Rapid
      : engine === 'musubi'
      ? OrchEngineTypes.Musubi
      : engine === 'ai-toolkit'
      ? OrchEngineTypes.AiToolkit
      : OrchEngineTypes.Kohya;
  },
};

/**
 * Map civitai ecosystem (from getBaseModelEcosystem) to AI Toolkit ecosystem format
 */
export function getAiToolkitEcosystem(baseModel: string): string | null {
  const { getBaseModelEcosystem } = require('~/shared/constants/base-model.constants');
  const civitaiEcosystem = getBaseModelEcosystem(baseModel);

  // Ecosystem mapping for AI Toolkit API
  const ecosystemMap: Record<string, string> = {
    // SD 1.x variants
    sd1: 'sd1',

    // SDXL variants (including Pony, Illustrious, NoobAI which have ecosystem: 'sdxl')
    sdxl: 'sdxl',
    pony: 'sdxl',
    illustrious: 'sdxl',
    noobai: 'sdxl',

    // Flux variants
    flux1: 'flux1',

    // SD3 variants
    sd3: 'sd3',
    sd3_5m: 'sd3', // SD 3.5 Medium has ecosystem: 'sd3'

    // Video models - all Wan/Hunyuan variants map to 'wan'
    wanvideo: 'wan',
    wanvideo14b_t2v: 'wan',
    wanvideo14b_i2v_480p: 'wan',
    wanvideo14b_i2v_720p: 'wan',
    'wanvideo-22-t2v-a14b': 'wan',
    'wanvideo-22-i2v-a14b': 'wan',
    'wanvideo-22-ti2v-5b': 'wan',
    'wanvideo-25-t2v': 'wan',
    'wanvideo-25-i2v': 'wan',
    hyv1: 'wan', // Hunyuan maps to wan ecosystem

    // Chroma
    chroma: 'chroma',
  };

  const mapped = ecosystemMap[civitaiEcosystem.toLowerCase()];
  if (!mapped) {
    console.warn(`Unknown ecosystem for AI Toolkit: ${civitaiEcosystem}`);
    return null;
  }

  return mapped;
}

/**
 * Get model variant for AI Toolkit based on base model
 */
export function getAiToolkitModelVariant(
  baseModel: TrainingDetailsBaseModelList
): string | undefined {
  // Model variant mapping based on specific models
  const variantMap: Partial<Record<TrainingDetailsBaseModelList, string>> = {
    // Flux variants
    flux_dev: 'dev',
    // 'flux_schnell': 'schnell',  // if/when added

    // SD3 variants
    // 'sd3_medium': 'medium',  // if/when enabled
    // 'sd3_large': 'large',    // if/when enabled

    // Wan variants - determine from model name
    wan_2_1_t2v_14b: '2.1',
    wan_2_1_i2v_14b_720p: '2.1',
    // Wan 2.2 models would be '2.2'
  };

  // If it's a custom model (civitai:xxx@yyy or AIR format), try to infer from URN
  if (typeof baseModel === 'string' && baseModel.includes('civitai:')) {
    return undefined;
  }

  return variantMap[baseModel as TrainingDetailsBaseModelList];
}

// Check if base model supports AI Toolkit
export const isAiToolkitSupported = (baseType: TrainingBaseModelType): boolean => {
  // AI Toolkit supports all base model types
  const supportedTypes: TrainingBaseModelType[] = [
    'sd15',
    'sdxl',
    'flux',
    'sd35',
    'hunyuan',
    'wan',
    'chroma',
  ];
  return supportedTypes.includes(baseType);
};

// Get default engine for base type
export const getDefaultEngine = (baseType: TrainingBaseModelType): EngineTypes => {
  if (baseType === 'hunyuan' || baseType === 'wan') return 'musubi';
  return 'kohya';
};

// Check if AI Toolkit is valid for the model
export const isValidAiToolkit = (
  baseModel: TrainingBaseModelType,
  engine: EngineTypes
): boolean => {
  return isAiToolkitSupported(baseModel) && engine === 'ai-toolkit';
};

// Check if AI Toolkit is invalid for the model
export const isInvalidAiToolkit = (
  baseModel: TrainingBaseModelType,
  engine: EngineTypes
): boolean => {
  return !isAiToolkitSupported(baseModel) && engine === 'ai-toolkit';
};

// TODO get this back from the dryRun
export const discountInfo = {
  amt: 0,
  bannerId: '9-13-24',
  endDate: '2024-09-28 00:00:00',
  message: 'Flux-Dev Rapid Training',
};
