import { Air } from '@civitai/client';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { getBaseModelEcosystem } from '~/shared/constants/base-model.constants';
import { ModelType } from '~/shared/utils/prisma/enums';

type CivitaiAir = {
  source: 'civitai';
  version: number;
  model: number;
};

type OrchestratorAir = {
  source: 'orchestrator';
  jobId: string;
  fileName: string;
};

type AIR = {
  ecosystem: string;
  type: string;
  format?: string | undefined;
} & (CivitaiAir | OrchestratorAir);

export function parseAIR(identifier: string) {
  const { id, version, ...value } = Air.parse(identifier);
  return { ...value, model: Number(id), version: Number(version) };
}

export function parseAIRSafe(identifier: string | undefined) {
  if (identifier === undefined) return identifier;
  const match = Air.parseSafe(identifier);
  if (!match) return match;

  const { id, version, ...value } = match;
  return { ...value, model: Number(id), version: Number(version) };
}

export function isAir(identifier: string) {
  return Air.isAir(identifier);
}

export function getAirModelLink(identifier: string) {
  const parsed = parseAIRSafe(identifier);
  if (!parsed) return '/';
  return `/models/${parsed.model}?modelVersionId=${parsed.version}`;
}

const typeUrnMap: Partial<Record<ModelType, string>> = {
  [ModelType.AestheticGradient]: 'ag',
  [ModelType.Checkpoint]: 'checkpoint',
  [ModelType.Hypernetwork]: 'hypernet',
  [ModelType.TextualInversion]: 'embedding',
  [ModelType.MotionModule]: 'motion',
  [ModelType.Upscaler]: 'upscaler',
  [ModelType.VAE]: 'vae',
  [ModelType.LORA]: 'lora',
  [ModelType.DoRA]: 'dora',
  [ModelType.LoCon]: 'lycoris',
  [ModelType.Controlnet]: 'controlnet',
};

export function stringifyAIR({
  baseModel,
  type,
  modelId,
  id,
  source = 'civitai',
}: {
  baseModel: BaseModel | string;
  type: ModelType;
  modelId: number | string;
  id?: number | string;
  source?: string;
}) {
  const ecosystem = getBaseModelEcosystem(baseModel);

  const urnType = typeUrnMap[type] ?? 'unknown';

  return Air.stringify({
    ecosystem: ecosystem,
    type: urnType,
    source,
    id: String(modelId),
    version: String(id),
  });
}
