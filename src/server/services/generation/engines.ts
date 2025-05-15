import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';

export interface GenerationEngine {
  engine: OrchestratorEngine2;
  disabled?: boolean;
  message?: string;
  memberOnly?: boolean;
  status?: 'mod-only' | 'published' | 'disabled';
}

export async function getGenerationEngines() {
  const enginesJson = await sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.ENGINES);
  return Object.values(enginesJson).map((engineJson) => JSON.parse(engineJson) as GenerationEngine);
}

export async function addGenerationEngine(data: GenerationEngine) {
  await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.ENGINES, data.engine, JSON.stringify(data));
}
