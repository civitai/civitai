import type { StoredEntryRating } from '~/server/redis/crucible-elo.redis';
import { crucibleEloRedis, CRUCIBLE_DEFAULT_ELO } from '~/server/redis/crucible-elo.redis';
import { createLogger } from '~/utils/logging';

const log = createLogger('crucible-elo', 'cyan');

/**
 * Standard ELO K-factors:
 * - Provisional (< 10 votes): K = 64 (higher volatility for quick ranking)
 * - Established (>= 10 votes): K = 32 (standard rating change)
 */
const K_FACTOR_PROVISIONAL = 64;
const K_FACTOR_ESTABLISHED = 32;
const PROVISIONAL_VOTE_THRESHOLD = 10;

export const processVote = async (
  crucibleId: number,
  winnerEntryId: number,
  loserEntryId: number,
  stored?: { winner: StoredEntryRating; loser: StoredEntryRating },
  frozen?: 'winner' | 'loser'
): Promise<{ winnerElo: number; loserElo: number }> => {
  const result = await crucibleEloRedis.processVoteAtomic(
    crucibleId,
    winnerEntryId,
    loserEntryId,
    {
      provisionalK: K_FACTOR_PROVISIONAL,
      establishedK: K_FACTOR_ESTABLISHED,
      provisionalVotes: PROVISIONAL_VOTE_THRESHOLD,
    },
    stored,
    frozen
  );

  log(
    `Vote processed: crucible ${crucibleId}, winner ${winnerEntryId} (${result.winnerOldElo} + ${result.winnerChange} = ${result.winnerElo}), loser ${loserEntryId} (${result.loserOldElo} + ${result.loserChange} = ${result.loserElo})`
  );

  return {
    winnerElo: result.winnerElo,
    loserElo: result.loserElo,
  };
};

/**
 * Initialize ELO score for a new entry in Redis
 *
 * @param crucibleId - The crucible ID
 * @param entryId - The entry ID to initialize
 */
export const initializeEntryElo = async (crucibleId: number, entryId: number): Promise<void> => {
  await crucibleEloRedis.initializeElo(crucibleId, entryId);
  log(`Initialized ELO for entry ${entryId} in crucible ${crucibleId}: ${CRUCIBLE_DEFAULT_ELO}`);
};

/**
 * Get the ELO score for an entry
 * Returns default ELO if not found
 *
 * @param crucibleId - The crucible ID
 * @param entryId - The entry ID
 * @returns The entry's current ELO score
 */
export const getEntryElo = async (crucibleId: number, entryId: number): Promise<number> => {
  const elo = await crucibleEloRedis.getElo(crucibleId, entryId);
  return elo ?? CRUCIBLE_DEFAULT_ELO;
};

/**
 * Get all ELO scores for a crucible
 * Useful for finalization and leaderboard display
 *
 * @param crucibleId - The crucible ID
 * @returns Map of entryId -> elo score
 */
export const getAllEntryElos = async (crucibleId: number): Promise<Record<number, number>> => {
  return crucibleEloRedis.getAllElos(crucibleId);
};

// Export constants for use elsewhere
export {
  CRUCIBLE_DEFAULT_ELO,
  K_FACTOR_PROVISIONAL,
  K_FACTOR_ESTABLISHED,
  PROVISIONAL_VOTE_THRESHOLD,
};
