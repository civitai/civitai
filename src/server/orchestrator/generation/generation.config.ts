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
import { polyGenGenerationConfig } from '~/server/orchestrator/polygen/polygen.schema';
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

// =============================================================================
// 3D Model generation (PolyGen / Meshy via Fal)
//
// PolyGen output isn't a video, so it lives in its own registry — kept in
// this file alongside `videoGenerationConfig2` so all generator engines
// have one discoverable home. The form + whatif machinery looks up the
// engine here with `getModel3DGenerationConfig`.
// =============================================================================

export type Model3DOrchestratorEngine = keyof typeof model3DGenerationConfig;
export const model3DGenerationConfig = {
  polyGen: polyGenGenerationConfig,
};
export type Model3DGenerationConfig =
  (typeof model3DGenerationConfig)[keyof typeof model3DGenerationConfig];
export type Model3DGenerationSchemaInfer = z.infer<Model3DGenerationConfig['schema']>;

export function getModel3DGenerationConfig(
  key: string
): Model3DGenerationConfig | undefined {
  return model3DGenerationConfig[key as Model3DOrchestratorEngine];
}
