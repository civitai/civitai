import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';

export interface GenerationEngine {
  engine: OrchestratorEngine2;
  disabled?: boolean;
  message?: string;
  memberOnly?: boolean;
  status?: 'mod-only' | 'published' | 'disabled';
}

const defaultEngines = [
  { engine: 'haiper', status: 'disabled' },
  {
    engine: 'veo3',
    disabled: false,
    status: 'published',
    message:
      'Be aware that Veo 3 is a PG model. Any use of profanity or sexually explicit language will result in a generic/unrelated PG video being returned, and you will not receive a refund.',
  },
  {
    engine: 'vidu',
    disabled: false,
    message: 'For best results, include an image in your generation request',
  },
  {
    engine: 'kling',
    disabled: false,
    message:
      'Due to low concurrency rates, expect longer wait times for Kling video generation requests',
  },
  { engine: 'civitai', disabled: true, status: 'disabled' },
  { engine: 'wan', disabled: false, message: '', status: 'published' },
  { engine: 'minimax', disabled: false, message: '' },
  { engine: 'hunyuan', disabled: false, message: '', status: 'published' },
  { engine: 'sora', disabled: false },
  {
    engine: 'lightricks',
    disabled: false,
    message: 'For best results, include an image in your generation request',
    status: 'published',
  },
  { engine: 'mochi', disabled: false, message: '' },
];

export async function getGenerationEngines() {
  const enginesJson = await sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.ENGINES);
  const obj = Object.values(enginesJson).map(
    (engineJson) => JSON.parse(engineJson) as GenerationEngine
  );
  if (Object.keys(obj).length === 0) {
    return defaultEngines;
  }
  return obj;
}

export async function addGenerationEngine(data: GenerationEngine) {
  await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.ENGINES, data.engine, JSON.stringify(data));
}
