import JSZip from 'jszip';
import { OrchEngineTypes, OrchPriorityTypes } from '~/server/common/enums';
import { getMimeTypeFromExt, IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import {
  EngineTypes,
  TrainingDetailsBaseModelList,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { getFileExtension } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const trainingBaseModelType = ['sd15', 'sdxl', 'flux'] as const;
export type TrainingBaseModelType = (typeof trainingBaseModelType)[number];

export const modelMap: { [key in TrainingDetailsBaseModelList]: string } = {
  sd_1_5: 'urn:air:sd1:checkpoint:civitai:127227@139180',
  anime: 'urn:air:sd1:checkpoint:civitai:84586@89927',
  semi: 'urn:air:sd1:checkpoint:civitai:4384@128713',
  realistic: 'urn:air:sd1:checkpoint:civitai:81458@132760',
  //
  sdxl: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
  pony: 'urn:air:sdxl:checkpoint:civitai:257749@290640',
  //
  flux_dev: 'urn:air:flux1:checkpoint:civitai:618692@691639',
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
        if (!IMAGE_MIME_TYPE.includes(mimeType as any)) return;
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
    return model in modelMap ? modelMap[model as keyof typeof modelMap] : model;
  },
  getPriority: (isPriority: boolean) => {
    return isPriority ? OrchPriorityTypes.High : OrchPriorityTypes.Normal;
  },
  getEngine: (engine: TrainingDetailsParams['engine']) => {
    return engine === 'rapid'
      ? OrchEngineTypes.Rapid
      : engine === 'x-flux'
      ? OrchEngineTypes['X-Flux']
      : OrchEngineTypes.Kohya;
  },
};

// TODO get this back from the dryRun
export const discountInfo = {
  amt: 0,
  bannerId: '9-13-24',
  endDate: '2024-09-28 00:00:00',
};
