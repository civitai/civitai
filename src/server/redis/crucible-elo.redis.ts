import type { RedisKeyTemplateSys } from './client';
import { sysRedis, REDIS_SYS_KEYS } from './client';
import { createLogger } from '~/utils/logging';

const log = createLogger('crucible-elo-redis', 'magenta');

const DEFAULT_ELO = 1500;

export type StoredEntryRating = { score: number; voteCount: number };
const UNRATED: StoredEntryRating = { score: DEFAULT_ELO, voteCount: 0 };

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
    log(
      `Incremented ELO for crucible ${crucibleId}, entry ${entryId} by ${change}: now ${newValue}`
    );
    return newValue;
  }

  /**
   * Applies one vote in a single Lua script, so concurrent votes can't lose updates or both read a
   * pre-vote count. Each side moves by its own K (provisional until `provisionalVotes`), which lets
   * a new entry find its level without pushing an established one as far.
   *
   * `stored` is each entry's last synced score and vote count, used for a field Redis no longer has:
   * after a wipe, starting again from the default would let the next sync overwrite Postgres.
   *
   * `frozen` names a side that stays as it is, rating and count: an entry the judge has already
   * voted on as often as allowed, served only to place the other one.
   */
  async processVoteAtomic(
    crucibleId: number,
    winnerEntryId: number,
    loserEntryId: number,
    k: { provisionalK: number; establishedK: number; provisionalVotes: number },
    stored: { winner: StoredEntryRating; loser: StoredEntryRating } = {
      winner: UNRATED,
      loser: UNRATED,
    },
    frozen?: 'winner' | 'loser'
  ): Promise<{
    winnerElo: number;
    loserElo: number;
    winnerOldElo: number;
    loserOldElo: number;
    winnerChange: number;
    loserChange: number;
  }> {
    const script = `
      local eloKey = KEYS[1]
      local votesKey = KEYS[2]
      local winnerField = ARGV[1]
      local loserField = ARGV[2]
      local provisionalK = tonumber(ARGV[3])
      local establishedK = tonumber(ARGV[4])
      local provisionalVotes = tonumber(ARGV[5])
      local winnerStoredElo = tonumber(ARGV[6])
      local winnerStoredVotes = tonumber(ARGV[7])
      local loserStoredElo = tonumber(ARGV[8])
      local loserStoredVotes = tonumber(ARGV[9])
      local frozen = ARGV[10]

      local winnerVotes = tonumber(redis.call('HGET', votesKey, winnerField)) or winnerStoredVotes
      local loserVotes = tonumber(redis.call('HGET', votesKey, loserField)) or loserStoredVotes
      local function kFor(votes)
        if votes < provisionalVotes then return provisionalK end
        return establishedK
      end
      local winnerK = kFor(winnerVotes)
      local loserK = kFor(loserVotes)

      local winnerElo = tonumber(redis.call('HGET', eloKey, winnerField)) or winnerStoredElo
      local loserElo = tonumber(redis.call('HGET', eloKey, loserField)) or loserStoredElo

      local expectedWinner = 1 / (1 + math.pow(10, (loserElo - winnerElo) / 400))
      local winnerChange = math.floor(winnerK * (1 - expectedWinner) + 0.5)
      local loserChange = -math.floor(loserK * (1 - expectedWinner) + 0.5)
      if frozen == 'winner' then winnerChange = 0 end
      if frozen == 'loser' then loserChange = 0 end

      local newWinnerElo = winnerElo + winnerChange
      local newLoserElo = loserElo + loserChange

      if frozen ~= 'winner' then
        redis.call('HSET', eloKey, winnerField, newWinnerElo)
        redis.call('HSET', votesKey, winnerField, winnerVotes + 1)
      end
      if frozen ~= 'loser' then
        redis.call('HSET', eloKey, loserField, newLoserElo)
        redis.call('HSET', votesKey, loserField, loserVotes + 1)
      end

      return {winnerElo, loserElo, newWinnerElo, newLoserElo, winnerChange, loserChange}
    `;

    const result = (await this.redis.eval(script, {
      keys: [this.getKey(crucibleId), this.getVotesKey(crucibleId)],
      arguments: [
        winnerEntryId.toString(),
        loserEntryId.toString(),
        k.provisionalK.toString(),
        k.establishedK.toString(),
        k.provisionalVotes.toString(),
        stored.winner.score.toString(),
        stored.winner.voteCount.toString(),
        stored.loser.score.toString(),
        stored.loser.voteCount.toString(),
        frozen ?? '',
      ],
    })) as number[];

    const [winnerOldElo, loserOldElo, newWinnerElo, newLoserElo, winnerChange, loserChange] =
      result;

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
