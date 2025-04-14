import { z } from 'zod';
import {
  HaiperInput,
  haiperVideoGenerationConfig,
} from '~/server/orchestrator/haiper/haiper.schema';
import {
  HunyuanInput,
  hunyuanVideoGenerationConfig,
} from '~/server/orchestrator/hunyuan/hunyuan.schema';
import { KlingInput, klingVideoGenerationConfig } from '~/server/orchestrator/kling/kling.schema';
import {
  LightricksInput,
  lightricksVideoGenerationConfig,
} from '~/server/orchestrator/lightricks/lightricks.schema';
import {
  MinimaxInput,
  minimaxVideoGenerationConfig,
} from '~/server/orchestrator/minimax/minimax.schema';
import { MochiInput, mochiVideoGenerationConfig } from '~/server/orchestrator/mochi/mochi.schema';
import { ViduInput, viduVideoGenerationConfig } from '~/server/orchestrator/vidu/vidu.schema';
import { WanInput, wanVideoGenerationConfig } from '~/server/orchestrator/wan/wan.schema';

export type VideoGenerationSchema = z.infer<(typeof videoGenerationConfig)[number]['schema']>;
export const videoGenerationConfig = [
  ...klingVideoGenerationConfig,
  ...minimaxVideoGenerationConfig,
  ...haiperVideoGenerationConfig,
  ...mochiVideoGenerationConfig,
  ...lightricksVideoGenerationConfig,
  ...hunyuanVideoGenerationConfig,
  ...viduVideoGenerationConfig,
  ...wanVideoGenerationConfig,
] as const;

export const videoGenerationInput = {
  kling: KlingInput,
  minimax: MinimaxInput,
  haiper: HaiperInput,
  mochi: MochiInput,
  lightricks: LightricksInput,
  hunyuan: HunyuanInput,
  vidu: ViduInput,
  wan: WanInput,
} as const;
