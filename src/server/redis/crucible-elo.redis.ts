import type { RedisKeyTemplateSys } from './client';
import { sysRedis, REDIS_SYS_KEYS } from './client';
import { createLogger } from '~/utils/logging';

const log = createLogger('crucible-elo-redis', 'magenta');

const DEFAULT_ELO = 1500;

/**
 * Redis client for Crucible ELO scores
 * Uses a hash per crucible where keys are entry IDs and values are ELO scores
 */
export class CrucibleEloRedisClient {
  private redis: typeof sysRedis;

  constructor(redisClient: typeof sysRedis) {
    this.redis = redisClient;
  }

  /**
   * Get the Redis key for a crucible's ELO hash
   */
  private getKey(crucibleId: number): RedisKeyTemplateSys {
    return `${REDIS_SYS_KEYS.CRUCIBLE.ELO}:${crucibleId}` as RedisKeyTemplateSys;
  }

  /**
   * Set the ELO score for an entry in a crucible
   */
  async setElo(crucibleId: number, entryId: number, elo: number): Promise<void> {
    const key = this.getKey(crucibleId);
    await this.redis.hSet(key, entryId.toString(), elo.toString());
    log(`Set ELO for crucible ${crucibleId}, entry ${entryId}: ${elo}`);
  }

  /**
   * Get the ELO score for an entry in a crucible
   * Returns null if the entry doesn't exist in Redis
   */
  async getElo(crucibleId: number, entryId: number): Promise<number | null> {
    const key = this.getKey(crucibleId);
    const value = await this.redis.hGet<string>(key, entryId.toString());
    return value ? parseInt(value, 10) : null;
  }

  /**
   * Get all ELO scores for a crucible
   * Returns a map of entryId -> elo score
   */
  async getAllElos(crucibleId: number): Promise<Record<number, number>> {
    const key = this.getKey(crucibleId);
    const values = await this.redis.hGetAll<string>(key);

    const result: Record<number, number> = {};
    for (const [entryIdStr, eloStr] of Object.entries(values)) {
      const entryId = parseInt(entryIdStr, 10);
      const elo = parseInt(eloStr as string, 10);
      if (!isNaN(entryId) && !isNaN(elo)) {
        result[entryId] = elo;
      }
    }

    return result;
  }

  /**
   * Increment (or decrement) the ELO score for an entry
   * Returns the new ELO value
   */
  async incrementElo(crucibleId: number, entryId: number, change: number): Promise<number> {
    const key = this.getKey(crucibleId);
    const newValue = await this.redis.hIncrBy(key, entryId.toString(), change);
    log(`Incremented ELO for crucible ${crucibleId}, entry ${entryId} by ${change}: now ${newValue}`);
    return newValue;
  }

  /**
   * Initialize ELO for a new entry with the default value (1500)
   */
  async initializeElo(crucibleId: number, entryId: number): Promise<void> {
    await this.setElo(crucibleId, entryId, DEFAULT_ELO);
  }

  /**
   * Check if an entry has an ELO score in Redis
   */
  async hasElo(crucibleId: number, entryId: number): Promise<boolean> {
    const key = this.getKey(crucibleId);
    return await this.redis.hExists(key, entryId.toString());
  }

  /**
   * Delete the ELO hash for a crucible (for cleanup after finalization)
   */
  async deleteCrucibleElos(crucibleId: number): Promise<boolean> {
    const key = this.getKey(crucibleId);
    const deleted = await this.redis.del(key);
    log(`Deleted ELO hash for crucible ${crucibleId}`);
    return deleted > 0;
  }

  /**
   * Set TTL on the crucible ELO hash (for automatic cleanup)
   */
  async setTTL(crucibleId: number, seconds: number): Promise<boolean> {
    const key = this.getKey(crucibleId);
    return await this.redis.expire(key, seconds);
  }

  /**
   * Set multiple ELO scores at once (for bulk initialization or updates)
   */
  async setMultipleElos(crucibleId: number, elos: Record<number, number>): Promise<void> {
    if (Object.keys(elos).length === 0) return;

    const key = this.getKey(crucibleId);
    const stringifiedElos: Record<string, string> = {};
    for (const [entryId, elo] of Object.entries(elos)) {
      stringifiedElos[entryId] = elo.toString();
    }
    await this.redis.hSet(key, stringifiedElos);
    log(`Set ${Object.keys(elos).length} ELO scores for crucible ${crucibleId}`);
  }
}

// Export singleton instance
export const crucibleEloRedis = new CrucibleEloRedisClient(sysRedis);

// Export default ELO constant for use elsewhere
export const CRUCIBLE_DEFAULT_ELO = DEFAULT_ELO;
