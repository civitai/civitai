import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';

export interface GenerationEngine {
  engine: OrchestratorEngine2;
  disabled?: boolean;
  message?: string;
  memberOnly?: boolean;
  status?: 'mod-only' | 'published' | 'disabled';
}

export async function getGenerationEngines() {
  // Fail open: called from trpc.generation.getGenerationEngines used by
  // VideoGenerationProvider on every video gen mount and /search/tools.
  // Returns an empty list on sysRedis error so the UI degrades to "no
  // engines available" rather than throwing a 500.
  let enginesJson: Record<string, string>;
  try {
    enginesJson = await sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.ENGINES);
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getGenerationEngines', err);
    return [];
  }
  return Object.values(enginesJson).map((engineJson) => JSON.parse(engineJson) as GenerationEngine);
}

export async function addGenerationEngine(data: GenerationEngine) {
  await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.ENGINES, data.engine, JSON.stringify(data));
}
