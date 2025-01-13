import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { GenerationEngine } from '~/shared/types/generation.types';

export async function getGenerationEngines() {
  const enginesJson = await sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.ENGINES);
  return Object.values(enginesJson).map((engineJson) => JSON.parse(engineJson) as GenerationEngine);
}

export async function addGenerationEngine(data: GenerationEngine) {
  await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.ENGINES, data.engine, JSON.stringify(data));
}
