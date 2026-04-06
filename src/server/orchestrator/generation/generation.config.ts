import type * as z from 'zod';
import { haiperGenerationConfig } from '~/server/orchestrator/haiper/haiper.schema';
import { hunyuanGenerationConfig } from '~/server/orchestrator/hunyuan/hunyuan.schema';
import { klingGenerationConfig } from '~/server/orchestrator/kling/kling.schema';
import {
  lightricksGenerationConfig,
  ltx2GenerationConfig,
} from '~/server/orchestrator/lightricks/lightricks.schema';
import { minimaxGenerationConfig } from '~/server/orchestrator/minimax/minimax.schema';
import { mochiGenerationConfig } from '~/server/orchestrator/mochi/mochi.schema';
import { veo3GenerationConfig } from '~/server/orchestrator/veo3/veo3.schema';
import { viduGenerationConfig } from '~/server/orchestrator/vidu/vidu.schema';
import { wanGenerationConfig } from '~/server/orchestrator/wan/wan.schema';
import { soraGenerationConfig } from '~/server/orchestrator/sora/sora.schema';

export type OrchestratorEngine2 = keyof typeof videoGenerationConfig2;
type VideoGenerationConfig = (typeof videoGenerationConfig2)[keyof typeof videoGenerationConfig2];
export type VideoGenerationSchema2 = z.infer<VideoGenerationConfig['schema']>;
export const videoGenerationConfig2 = {
  veo3: veo3GenerationConfig,
  vidu: viduGenerationConfig,
  minimax: minimaxGenerationConfig,
  kling: klingGenerationConfig,
  lightricks: lightricksGenerationConfig,
  ltx2: ltx2GenerationConfig,
  haiper: haiperGenerationConfig,
  mochi: mochiGenerationConfig,
  hunyuan: hunyuanGenerationConfig,
  wan: wanGenerationConfig,
  sora: soraGenerationConfig,
};

export function getVideoGenerationConfig(key: string): VideoGenerationConfig | undefined {
  return videoGenerationConfig2[key as OrchestratorEngine2];
}
