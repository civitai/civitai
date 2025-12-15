import {
  wanBaseModelGroupIdMap,
  wanGeneralBaseModelMap,
} from '~/server/orchestrator/wan/wan.schema';
import { getBaseModelEngine, type BaseModelGroup } from '~/shared/constants/base-model.constants';
import { cleanPrompt } from '~/utils/metadata/audit';
import { getWanVersion } from '../orchestrator/wan/wan.schema';

type BaseMeta = {
  type?: string;
  process?: string;
  prompt?: string;
  negativePrompt?: string;
};

type CivitaiResource = {
  type?: string;
  weight?: number;
  modelVersionId: number;
};

type Comfy = {
  prompt?: Record<string, unknown>;
  workflow?: {
    [x: string]: unknown;
    nodes?: Record<string, unknown>[];
  };
};

type MetaResource = {
  modelVersionId: number;
  strength?: number;
};

type ImageProps = {
  url: string;
  width: number;
  height: number;
  upscaleWidth?: number;
  upscaleHeight?: number;
};

type WanVideoGenMeta = BaseMeta & {
  version?: string;
  engine: string;
  cfgScale?: number;
  duration?: number;
  quantity?: number;
  workflow?: string;
  baseModel?: BaseModelGroup;
  frameRate?: number;
  aspectRatio?: string;
  steps?: number;
  seed?: number;
  sourceImage?: ImageProps;
  images?: ImageProps[];
  resolution?: string;
};

type NormalizeMetaProps = {
  civitaiResources?: CivitaiResource[];
  resources?: unknown;
  type?: string;
  process?: string;
  engine?: string;
  baseModel?: string;
};

export function getMetaResources({
  baseModel,
  civitaiResources,
}: {
  baseModel?: BaseModelGroup;
  civitaiResources?: CivitaiResource[];
}) {
  const resources =
    civitaiResources?.map(({ weight, modelVersionId }) => ({
      modelVersionId: Number(modelVersionId),
      strength: weight,
    })) ?? [];

  // add missing resource by baseModel
  const modelVersionId = baseModel ? wanBaseModelGroupIdMap[baseModel] : undefined;
  if (modelVersionId && !resources.find((x) => x.modelVersionId === modelVersionId)) {
    resources.push({ modelVersionId, strength: undefined });
  }
  return resources;
}

export function normalizeMeta<T extends NormalizeMetaProps>(initialMeta: T) {
  const { civitaiResources, resources: stripThisVariable, type, ...meta } = initialMeta;
  const prompt = 'prompt' in meta ? (meta.prompt as string) : undefined;
  const negativePrompt = 'negativePrompt' in meta ? (meta.negativePrompt as string) : undefined;
  const process = meta.process ?? (type && typeof type === 'string') ? type : undefined;
  const engine = meta.engine ?? (meta.baseModel ? getBaseModelEngine(meta.baseModel) : undefined);
  const data = {
    ...meta,
    ...cleanPrompt({ prompt, negativePrompt }),
    process,
    engine,
  };

  if ('engine' in data && typeof data.engine === 'string') {
    switch (data.engine) {
      case 'wan':
        return processWanVideoGenMeta(data as WanVideoGenMeta);
      case 'hunyuan':
        return data; // TODO
      case 'veo3':
        return data; // TODO
    }
  }
  return data;
}

function processWanVideoGenMeta(data: WanVideoGenMeta) {
  let baseModel = data.baseModel ?? 'WanVideo';

  if (baseModel === 'WanVideo' || !baseModel) {
    if (data.process === 'txt2vid') baseModel = 'WanVideo14B_T2V';
    else if (data.process === 'img2vid') {
      baseModel = 'WanVideo14B_I2V_480p';
      if (data.resolution === '720p') baseModel = 'WanVideo14B_I2V_720p';
    }
  }

  const match = wanGeneralBaseModelMap.find((x) => x.baseModel === data.baseModel);
  if (match) {
    if (!data.process) data.process = match.process;
    if (!data.resolution && 'resolution' in match) data.resolution = match.resolution;
  }

  data.version = getWanVersion(baseModel);

  if (data.sourceImage) {
    data.images = [data.sourceImage];
    delete data.sourceImage;
  }
  delete data.workflow;
  return { ...data, baseModel };
}
