import { z } from 'zod';
import type { BaseModelSetType } from '~/server/common/constants';
import { haiperGenerationConfig } from '~/server/orchestrator/haiper/haiper.schema';
import { hunyuanGenerationConfig } from '~/server/orchestrator/hunyuan/hunyuan.schema';
import { klingGenerationConfig } from '~/server/orchestrator/kling/kling.schema';
import {
  LightricksInput,
  lightricksVideoGenerationConfig,
} from '~/server/orchestrator/lightricks/lightricks.schema';
import { minimaxGenerationConfig } from '~/server/orchestrator/minimax/minimax.schema';
import { MochiInput, mochiVideoGenerationConfig } from '~/server/orchestrator/mochi/mochi.schema';
import { viduGenerationConfig } from '~/server/orchestrator/vidu/vidu.schema';
import { wanGenerationConfig } from '~/server/orchestrator/wan/wan.schema';

export type VideoGenerationSchema = z.infer<(typeof videoGenerationConfig)[number]['schema']>;
export type VideoGenerationEngine = (typeof videoGenerationConfig)[number]['engine'];
export const videoGenerationConfig = [
  // ...klingVideoGenerationConfig,
  // ...minimaxVideoGenerationConfig,
  // ...haiperVideoGenerationConfig,
  // ...mochiVideoGenerationConfig,
  // ...lightricksVideoGenerationConfig,
  // ...hunyuanVideoGenerationConfig,
  // ...viduVideoGenerationConfig,
  // ...wanVideoGenerationConfig,
] as const;

export const videoGenerationInput = {
  // kling: KlingInput,
  // minimax: MinimaxInput,
  // haiper: HaiperInput,
  // mochi: MochiInput,
  // lightricks: LightricksInput,
  // hunyuan: HunyuanInput,
  // vidu: ViduInput,
  // wan: WanInput,
} as const;

export const baseModelEngineMap: Partial<Record<BaseModelSetType, OrchestratorEngine2>> = {
  WanVideo: 'wan',
  HyV1: 'hunyuan',
};

export type OrchestratorEngine2 = keyof typeof videoGenerationConfig2;
type VideoGenerationConfig = (typeof videoGenerationConfig2)[keyof typeof videoGenerationConfig2];
export type VideoGenerationSchema2 = z.infer<VideoGenerationConfig['schema']>;
export const videoGenerationConfig2 = {
  vidu: viduGenerationConfig,
  wan: wanGenerationConfig,
  hunyuan: hunyuanGenerationConfig,
  kling: klingGenerationConfig,
  minimax: minimaxGenerationConfig,
  haiper: haiperGenerationConfig,
};
