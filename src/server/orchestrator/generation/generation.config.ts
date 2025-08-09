import type * as z from 'zod/v4';
import { haiperGenerationConfig } from '~/server/orchestrator/haiper/haiper.schema';
import { hunyuanGenerationConfig } from '~/server/orchestrator/hunyuan/hunyuan.schema';
import { klingGenerationConfig } from '~/server/orchestrator/kling/kling.schema';
import { lightricksGenerationConfig } from '~/server/orchestrator/lightricks/lightricks.schema';
import { minimaxGenerationConfig } from '~/server/orchestrator/minimax/minimax.schema';
import { mochiGenerationConfig } from '~/server/orchestrator/mochi/mochi.schema';
import { veo3GenerationConfig } from '~/server/orchestrator/veo3/veo3.schema';
import { viduGenerationConfig } from '~/server/orchestrator/vidu/vidu.schema';
import { wanGenerationConfig } from '~/server/orchestrator/wan/wan.schema';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';
import { getBaseModelGroup } from '~/shared/constants/base-model.constants';

export const baseModelEngineMap: Partial<Record<BaseModelGroup, OrchestratorEngine2>> = {
  WanVideo: 'wan',
  WanVideo14B_I2V_480p: 'wan',
  WanVideo14B_I2V_720p: 'wan',
  WanVideo14B_T2V: 'wan',
  WanVideo1_3B_T2V: 'wan',
  HyV1: 'hunyuan',
  Veo3: 'veo3',
};

export function getEngineFromBaseModel(baseModel: string) {
  const group = getBaseModelGroup(baseModel);
  return group ? baseModelEngineMap[group] : undefined;
}

export const modelIdEngineMap = new Map<number, OrchestratorEngine2>([[982559, 'lightricks']]);

export type OrchestratorEngine2 = keyof typeof videoGenerationConfig2;
type VideoGenerationConfig = (typeof videoGenerationConfig2)[keyof typeof videoGenerationConfig2];
export type VideoGenerationSchema2 = z.infer<VideoGenerationConfig['schema']>;
export const videoGenerationConfig2 = {
  veo3: veo3GenerationConfig,
  vidu: viduGenerationConfig,
  minimax: minimaxGenerationConfig,
  kling: klingGenerationConfig,
  lightricks: lightricksGenerationConfig,
  haiper: haiperGenerationConfig,
  mochi: mochiGenerationConfig,
  hunyuan: hunyuanGenerationConfig,
  wan: wanGenerationConfig,
};

export function isVideoGenerationEngine(engine?: string) {
  return engine ? !!videoGenerationConfig2[engine as OrchestratorEngine2] : false;
}

export function getVideoGenerationConfig(key: string): VideoGenerationConfig | undefined {
  return videoGenerationConfig2[key as OrchestratorEngine2];
}
