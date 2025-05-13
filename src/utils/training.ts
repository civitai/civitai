import type JSZip from 'jszip';
import type { BaseModel } from '~/server/common/constants';
import { OrchEngineTypes, OrchPriorityTypes } from '~/server/common/enums';
import { getMimeTypeFromExt, MEDIA_TYPE } from '~/server/common/mime-types';
import type {
  TrainingDetailsBaseModelList,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { getFileExtension } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const trainingBaseModelTypesImage = ['sd15', 'sdxl', 'sd35', 'flux'] as const;
export const trainingBaseModelTypesVideo = ['hunyuan', 'wan'] as const;
export const trainingBaseModelType = [
  ...trainingBaseModelTypesImage,
  ...trainingBaseModelTypesVideo,
] as const;
export type TrainingBaseModelType = (typeof trainingBaseModelType)[number];

export const engineTypes = ['kohya', 'rapid', 'musubi'] as const;
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
  sd3_medium: {
    label: 'Medium',
    pretty: 'SD 3.5 M',
    type: 'sd35',
    description: 'Designed for a balance of quality and efficiency.',
    air: 'urn:air:sd3:checkpoint:civitai:896953@1003708',
    baseModel: 'SD 3.5 Medium',
    isNew: false,
  },
  sd3_large: {
    label: 'Large',
    pretty: 'SD 3.5 L',
    type: 'sd35',
    description: 'Designed for high-quality images across diverse styles.',
    air: 'urn:air:sd3:checkpoint:civitai:878387@983309',
    baseModel: 'SD 3.5 Large',
    isNew: false,
  },
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
    label: '720p fp8',
    pretty: 'Hunyuan 720p fp8',
    type: 'hunyuan',
    description: 'Performant video generation.',
    // air: 'urn:air:hyv1:checkpoint:civitai:1167575@1314512',
    air: 'urn:air:hyv1:vae:huggingface:tencent/HunyuanVideo@main/hunyuan-video-t2v-720p/vae/pytorch_model.pt',
    baseModel: 'Hunyuan Video',
    isNew: false,
  },
  wan_2_1_720p: {
    label: '2.1 720p',
    pretty: 'Wan 2.1 720p',
    type: 'wan',
    description: 'Performant and high quality video generation.',
    // air: 'urn:air:wanvideo:checkpoint:civitai:1329096@1501344',
    air: 'urn:air:wanvideo:vae:huggingface:Wan-AI/Wan2.1-I2V-14B-720P@main/Wan2.1_VAE.pth',
    baseModel: 'Wan Video',
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
    return isPriority ? OrchPriorityTypes.High : OrchPriorityTypes.Normal;
  },
  getEngine: (engine: TrainingDetailsParams['engine']) => {
    return engine === 'rapid'
      ? OrchEngineTypes.Rapid
      : engine === 'musubi'
      ? OrchEngineTypes.Musubi
      : OrchEngineTypes.Kohya;
  },
};

// TODO get this back from the dryRun
export const discountInfo = {
  amt: 0,
  bannerId: '9-13-24',
  endDate: '2024-09-28 00:00:00',
  message: 'Flux-Dev Rapid Training',
};
