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
   * Process a vote atomically using a Lua script
   * This prevents race conditions from concurrent votes by ensuring read-compute-update happens atomically
   *
   * @param crucibleId - The crucible ID
   * @param winnerEntryId - The entry ID that won
   * @param loserEntryId - The entry ID that lost
   * @param winnerKFactor - The K-factor for the winner
   * @param loserKFactor - The K-factor for the loser
   * @returns Object with old and new ELO values and changes for both entries
   */
  async processVoteAtomic(
    crucibleId: number,
    winnerEntryId: number,
    loserEntryId: number,
    winnerKFactor: number,
    loserKFactor: number
  ): Promise<{
    winnerElo: number;
    loserElo: number;
    winnerOldElo: number;
    loserOldElo: number;
    winnerChange: number;
    loserChange: number;
  }> {
    const key = this.getKey(crucibleId);

    // Lua script for atomic read-compute-update of ELO scores
    // This prevents race conditions by running all operations on the Redis server
    // IMPORTANT: Uses zero-sum ELO calculation to prevent rating inflation
    const script = `
      local eloKey = KEYS[1]
      local winnerField = ARGV[1]
      local loserField = ARGV[2]
      local winnerK = tonumber(ARGV[3])
      local loserK = tonumber(ARGV[4])
      local defaultElo = tonumber(ARGV[5])

      -- Get current ELO scores (use default if not set)
      local winnerElo = tonumber(redis.call('HGET', eloKey, winnerField)) or defaultElo
      local loserElo = tonumber(redis.call('HGET', eloKey, loserField)) or defaultElo

      -- Calculate expected score for winner using ELO formula
      -- Expected probability that winner beats loser: 1 / (1 + 10^((loserElo - winnerElo) / 400))
      local expectedWinner = 1 / (1 + math.pow(10, (loserElo - winnerElo) / 400))

      -- Use averaged K-factor to ensure zero-sum outcome
      -- This prevents ELO inflation that occurs when players have different K-factors
      local avgK = (winnerK + loserK) / 2

      -- Calculate winner's rating change using averaged K-factor
      -- Winner gets actual score of 1, expected was expectedWinner
      local winnerChange = math.floor(avgK * (1 - expectedWinner) + 0.5)
      -- Loser change is negative of winner change (zero-sum)
      local loserChange = -winnerChange

      -- Update ELO scores
      local newWinnerElo = winnerElo + winnerChange
      local newLoserElo = loserElo + loserChange

      redis.call('HSET', eloKey, winnerField, newWinnerElo)
      redis.call('HSET', eloKey, loserField, newLoserElo)

      -- Return old and new values for logging
      return {winnerElo, loserElo, newWinnerElo, newLoserElo, winnerChange, loserChange}
    `;

    const result = await this.redis.eval(script, {
      keys: [key],
      arguments: [
        winnerEntryId.toString(),
        loserEntryId.toString(),
        winnerKFactor.toString(),
        loserKFactor.toString(),
        DEFAULT_ELO.toString(),
      ],
    }) as number[];

    const [winnerOldElo, loserOldElo, newWinnerElo, newLoserElo, winnerChange, loserChange] = result;

    log(
      `Atomic vote: crucible ${crucibleId}, winner ${winnerEntryId} (${winnerOldElo} -> ${newWinnerElo}), loser ${loserEntryId} (${loserOldElo} -> ${newLoserElo})`
    );

    return {
      winnerElo: newWinnerElo,
      loserElo: newLoserElo,
      winnerOldElo,
      loserOldElo,
      winnerChange,
      loserChange,
    };
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
    const votesKey = this.getVotesKey(crucibleId);
    // Set TTL on both ELO and votes hashes
    const [eloResult] = await Promise.all([
      this.redis.expire(key, seconds),
      this.redis.expire(votesKey, seconds),
    ]);
    return eloResult;
  }

  // ============================================================================
  // Vote Count Tracking
  // ============================================================================

  /**
   * Get the Redis key for a crucible's vote counts hash
   */
  private getVotesKey(crucibleId: number): RedisKeyTemplateSys {
    return `${REDIS_SYS_KEYS.CRUCIBLE.ELO}:${crucibleId}:votes` as RedisKeyTemplateSys;
  }

  /**
   * Get the vote count for an entry in a crucible
   * Returns 0 if the entry doesn't exist in Redis
   */
  async getVoteCount(crucibleId: number, entryId: number): Promise<number> {
    const key = this.getVotesKey(crucibleId);
    const value = await this.redis.hGet<string>(key, entryId.toString());
    return value ? parseInt(value, 10) : 0;
  }

  /**
   * Increment vote count for an entry (called when entry participates in a vote)
   * Returns the new vote count
   */
  async incrementVoteCount(crucibleId: number, entryId: number): Promise<number> {
    const key = this.getVotesKey(crucibleId);
    const newValue = await this.redis.hIncrBy(key, entryId.toString(), 1);
    return newValue;
  }

  /**
   * Get all vote counts for a crucible
   * Returns a map of entryId -> vote count
   */
  async getAllVoteCounts(crucibleId: number): Promise<Record<number, number>> {
    const key = this.getVotesKey(crucibleId);
    const values = await this.redis.hGetAll<string>(key);

    const result: Record<number, number> = {};
    for (const [entryIdStr, countStr] of Object.entries(values)) {
      const entryId = parseInt(entryIdStr, 10);
      const count = parseInt(countStr as string, 10);
      if (!isNaN(entryId) && !isNaN(count)) {
        result[entryId] = count;
      }
    }

    return result;
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
