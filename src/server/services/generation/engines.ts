import { redis, REDIS_KEYS } from '~/server/redis/client';
import { GenerationEngine } from '~/shared/types/generation.types';

export async function getGenerationEngines() {
  const enginesJson = await redis.hGetAll(REDIS_KEYS.GENERATION.ENGINES);
  return Object.values(enginesJson).map((engineJson) => JSON.parse(engineJson) as GenerationEngine);
}

export async function addGenerationEngine(data: GenerationEngine) {
  await redis.hSet(REDIS_KEYS.GENERATION.ENGINES, data.engine, JSON.stringify(data));
}
