import type JSZip from 'jszip';
import { getBaseModelEcosystem, type BaseModel } from '~/shared/constants/base-model.constants';
import { OrchEngineTypes, OrchPriorityTypes } from '~/server/common/enums';
import { getMimeTypeFromExt, MEDIA_TYPE } from '~/shared/constants/mime-types';
import type {
  TrainingDetailsBaseModelList,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { getFileExtension } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const trainingBaseModelTypesImage = [
  'sd15',
  'sdxl',
  'sd35',
  'flux',
  'flux2',
  'chroma',
  'qwen',
  'zimageturbo',
] as const;
export const trainingBaseModelTypesVideo = ['hunyuan', 'wan'] as const;
export const trainingBaseModelType = [
  ...trainingBaseModelTypesImage,
  ...trainingBaseModelTypesVideo,
] as const;
export type TrainingBaseModelType = (typeof trainingBaseModelType)[number];

export const engineTypes = [
  'kohya',
  'rapid',
  'flux2-dev',
  'flux2-dev-edit',
  'musubi',
  'ai-toolkit',
] as const;
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
    aiToolkit?: {
      ecosystem: string;
      modelVariant?: string;
    };
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
    aiToolkit: { ecosystem: 'sd1' },
  },
  anime: {
    label: 'Anime',
    pretty: 'Anime',
    type: 'sd15',
    description: 'Results will have an anime aesthetic.',
    air: 'urn:air:sd1:checkpoint:civitai:84586@89927',
    baseModel: 'SD 1.5',
    isNew: false,
    aiToolkit: { ecosystem: 'sd1' },
  },
  semi: {
    label: 'Semi-realistic',
    pretty: 'Semi Real',
    type: 'sd15',
    description: 'Results will be a blend of anime and realism.',
    air: 'urn:air:sd1:checkpoint:civitai:4384@128713',
    baseModel: 'SD 1.5',
    isNew: false,
    aiToolkit: { ecosystem: 'sd1' },
  },
  realistic: {
    label: 'Realistic',
    pretty: 'Realistic',
    type: 'sd15',
    description: 'Results will be extremely realistic.',
    air: 'urn:air:sd1:checkpoint:civitai:81458@132760',
    baseModel: 'SD 1.5',
    isNew: false,
    aiToolkit: { ecosystem: 'sd1' },
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
    aiToolkit: { ecosystem: 'sdxl' },
  },
  pony: {
    label: 'Pony',
    pretty: 'Pony',
    type: 'sdxl',
    description: 'Tailored to visuals of various anthro, feral, or humanoid species.',
    air: 'urn:air:sdxl:checkpoint:civitai:257749@290640',
    baseModel: 'Pony',
    isNew: false,
    aiToolkit: { ecosystem: 'sdxl' },
  },
  illustrious: {
    label: 'Illustrious',
    pretty: 'Illustrious',
    type: 'sdxl',
    description: 'Optimized for illustration and animation.',
    air: 'urn:air:sdxl:checkpoint:civitai:795765@889818',
    baseModel: 'Illustrious',
    isNew: false,
    aiToolkit: { ecosystem: 'sdxl' },
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
    aiToolkit: { ecosystem: 'flux1', modelVariant: 'dev' },
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
    aiToolkit: { ecosystem: 'wan' }, // Hunyuan uses wan ecosystem
  },
  wan_2_1_t2v_14b: {
    label: '2.1 T2V [14B]',
    pretty: 'Wan 2.1 T2V [14B]',
    type: 'wan',
    description: 'Performant and high quality video generation (for T2V).',
    air: 'urn:air:wanvideo:vae:huggingface:Wan-AI/Wan2.1-I2V-14B-720P@main/Wan2.1_VAE.pth', // actually t2v, uses HF
    baseModel: 'Wan Video 14B t2v',
    isNew: false,
    aiToolkit: { ecosystem: 'wan', modelVariant: '2.1' },
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
    aiToolkit: { ecosystem: 'wan', modelVariant: '2.1' },
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
    aiToolkit: { ecosystem: 'chroma' },
  },
  //
  qwen_image: {
    label: 'Qwen-Image',
    pretty: 'Qwen-Image',
    type: 'qwen',
    description: 'High-quality image generation with advanced understanding.',
    air: 'urn:air:qwen:checkpoint:civitai:1864281@2110043',
    baseModel: 'Qwen',
    isNew: true,
    aiToolkit: { ecosystem: 'qwen' },
  },
  //
  zimageturbo: {
    label: 'Turbo',
    pretty: 'ZImageTurbo',
    type: 'zimageturbo',
    description: 'High-speed image generation with turbo acceleration.',
    air: 'urn:air:zimageturbo:checkpoint:civitai:2168935@2442439',
    baseModel: 'ZImageTurbo',
    isNew: true,
    aiToolkit: { ecosystem: 'zimageturbo' },
  },
  //
  flux2_dev: {
    label: 'Dev',
    pretty: 'Flux.2',
    type: 'flux2',
    description: 'Next generation high-quality image generation.',
    air: 'urn:air:flux2:checkpoint:civitai:2165902@2439067',
    baseModel: 'Flux.2 D',
    isNew: true,
  },
  // flux2_dev_edit: {
  //   label: 'Dev Edit',
  //   pretty: 'Flux.2 Edit',
  //   type: 'flux2',
  //   description: 'Next generation image editing and generation.',
  //   air: 'urn:air:flux2:checkpoint:civitai:2165902@2439067',
  //   baseModel: 'Flux.2 D',
  //   isNew: true,
  // },
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
  // Flux1 rapid engine
  if (baseModel === 'flux' && engine === 'rapid') return true;
  // Flux2 uses its own rapid-like engines
  if (baseModel === 'flux2' && (engine === 'flux2-dev' || engine === 'flux2-dev-edit')) return true;
  return false;
};

export const isInvalidRapid = (baseModel: TrainingBaseModelType, engine: EngineTypes) => {
  // Rapid engine is only valid for Flux1
  if (engine === 'rapid' && baseModel !== 'flux') return true;
  // Flux2 engines are only valid for Flux2
  if ((engine === 'flux2-dev' || engine === 'flux2-dev-edit') && baseModel !== 'flux2') return true;
  return false;
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
    switch (engine) {
      case 'rapid':
        return OrchEngineTypes.Rapid;
      case 'flux2-dev':
        return OrchEngineTypes.Flux2Dev;
      case 'flux2-dev-edit':
        return OrchEngineTypes.Flux2DevEdit;
      case 'musubi':
        return OrchEngineTypes.Musubi;
      case 'ai-toolkit':
        return OrchEngineTypes.AiToolkit;
      default:
        return OrchEngineTypes.Kohya;
    }
  },
};

/**
 * Get AI Toolkit ecosystem for a training model
 * Reads from the centralized trainingModelInfo structure
 */
export function getAiToolkitEcosystem(baseModel: string): string | null {
  const modelInfo = trainingModelInfo[baseModel as TrainingDetailsBaseModelList];

  if (modelInfo?.aiToolkit) {
    return modelInfo.aiToolkit.ecosystem;
  }

  // For custom models, we can't determine the ecosystem
  console.warn(`No AI Toolkit ecosystem configured for: ${baseModel}`);
  return null;
}

/**
 * Get AI Toolkit model variant for a training model
 * Reads from the centralized trainingModelInfo structure
 */
export function getAiToolkitModelVariant(
  baseModel: TrainingDetailsBaseModelList
): string | undefined {
  // Custom models (AIR URNs or civitai:xxx@yyy format) don't have variants
  if (typeof baseModel === 'string' && baseModel.includes('civitai:')) {
    return undefined;
  }

  const modelInfo = trainingModelInfo[baseModel as TrainingDetailsBaseModelList];
  return modelInfo?.aiToolkit?.modelVariant;
}

// Check if base model supports AI Toolkit
export const isAiToolkitSupported = (baseType: TrainingBaseModelType): boolean => {
  // AI Toolkit supports these base model types (flux2 is not included - it only uses rapid)
  const supportedTypes: TrainingBaseModelType[] = [
    'sd15',
    'sdxl',
    'flux',
    'sd35',
    'hunyuan',
    'wan',
    'chroma',
    'qwen',
    'zimageturbo',
  ];
  return supportedTypes.includes(baseType);
};

// Check if AI Toolkit is mandatory (cannot use other engines)
export const isAiToolkitMandatory = (baseType: TrainingBaseModelType): boolean => {
  const mandatoryTypes: TrainingBaseModelType[] = ['qwen', 'zimageturbo'];
  return mandatoryTypes.includes(baseType);
};

// Get default engine for base type
export const getDefaultEngine = (
  baseType: TrainingBaseModelType,
  baseModel?: string
): EngineTypes => {
  if (baseType === 'qwen') return 'ai-toolkit'; // Qwen requires AI Toolkit
  if (baseType === 'zimageturbo') return 'ai-toolkit'; // ZImageTurbo requires AI Toolkit
  if (baseType === 'hunyuan' || baseType === 'wan') return 'musubi';
  // Flux2 uses its own rapid-like engines based on the specific model
  if (baseType === 'flux2') {
    if (baseModel === 'flux2_dev_edit') return 'flux2-dev-edit';
    return 'flux2-dev'; // Default for flux2_dev
  }
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

// Check if sample prompts are required for training
// This includes AI Toolkit mandatory models and Flux2
export const isSamplePromptsRequired = (
  baseType: TrainingBaseModelType,
  engine?: EngineTypes
): boolean => {
  // AI Toolkit mandatory models always require sample prompts
  if (isAiToolkitMandatory(baseType)) return true;
  // Flux2 requires sample prompts
  if (baseType === 'flux2') return true;
  // AI Toolkit engine requires sample prompts
  if (engine === 'ai-toolkit') return true;
  return false;
};

// TODO get this back from the dryRun
export const discountInfo = {
  amt: 0,
  bannerId: '9-13-24',
  endDate: '2024-09-28 00:00:00',
  message: 'Flux-Dev Rapid Training',
};
