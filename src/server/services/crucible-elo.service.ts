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

/**
 * Estimate the ELO rating change after a match (for UI preview only)
 *
 * **NOTE:** This is a simplified estimation function for UI/preview purposes only.
 * The actual ELO changes are calculated atomically in Redis using the Lua script in
 * `src/server/redis/crucible-elo.redis.ts` (see `processVoteAtomic` method).
 * The Lua script is the authoritative implementation and uses averaged K-factors
 * to ensure zero-sum outcomes.
 *
 * Based on the standard ELO formula:
 * - Expected score: Ea = 1 / (1 + 10^((Rb - Ra) / 400))
 * - New rating: Ra' = Ra + K * (Sa - Ea)
 *
 * @param winnerElo - Current ELO of the winner
 * @param loserElo - Current ELO of the loser
 * @param kFactor - K-factor to use (default: 32) - Note: actual votes use averaged K-factors
 * @returns [winnerChange, loserChange] - Estimated change in ELO for winner (positive) and loser (negative)
 */
export const estimateEloChange = (
  winnerElo: number,
  loserElo: number,
  kFactor: number = K_FACTOR_ESTABLISHED
): [number, number] => {
  // Calculate expected scores using the ELO formula
  // Expected probability that winner beats loser
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  // Expected probability that loser beats winner
  const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));

  // Actual scores: winner gets 1, loser gets 0
  const actualWinner = 1;
  const actualLoser = 0;

  // Calculate rating changes
  // Ensure zero-sum: loserChange = -winnerChange to prevent ELO drift from rounding
  const winnerChange = Math.round(kFactor * (actualWinner - expectedWinner));
  const loserChange = -winnerChange;

  return [winnerChange, loserChange];
};

/**
 * Determine the K-factor based on vote count
 * Higher K-factor for provisional ratings (fewer votes) allows faster convergence
 *
 * @param voteCount - Total votes on the entry
 * @returns K-factor to use (64 if provisional, 32 otherwise)
 */
export const getKFactor = (voteCount: number): number => {
  return voteCount < PROVISIONAL_VOTE_THRESHOLD ? K_FACTOR_PROVISIONAL : K_FACTOR_ESTABLISHED;
};

/**
 * Process a vote by updating ELO scores in Redis atomically
 * Uses a Lua script to prevent race conditions from concurrent votes
 *
 * ATOMICITY: All read-compute-update operations happen atomically in Redis
 * - Eliminates race conditions where concurrent votes could corrupt ELO scores
 * - Prevents lost updates by ensuring sequential processing
 *
 * @param crucibleId - The crucible ID
 * @param winnerEntryId - The entry ID that won the vote
 * @param loserEntryId - The entry ID that lost the vote
 * @param winnerVoteCount - Current vote count of the winner (for K-factor)
 * @param loserVoteCount - Current vote count of the loser (for K-factor)
 * @returns Object with new ELO values for both entries
 */
export const processVote = async (
  crucibleId: number,
  winnerEntryId: number,
  loserEntryId: number,
  winnerVoteCount: number,
  loserVoteCount: number
): Promise<{ winnerElo: number; loserElo: number }> => {
  // Calculate K-factor for each player based on their vote counts
  // Each player uses their own K-factor for their rating change (standard ELO)
  const winnerKFactor = getKFactor(winnerVoteCount);
  const loserKFactor = getKFactor(loserVoteCount);

  // Use Lua script for atomic read-compute-update
  // This prevents race conditions from concurrent votes
  const result = await crucibleEloRedis.processVoteAtomic(
    crucibleId,
    winnerEntryId,
    loserEntryId,
    winnerKFactor,
    loserKFactor
  );

  log(
    `Vote processed: crucible ${crucibleId}, winner ${winnerEntryId} (${result.winnerOldElo} + ${result.winnerChange} = ${result.winnerElo}, K=${winnerKFactor}), loser ${loserEntryId} (${result.loserOldElo} + ${result.loserChange} = ${result.loserElo}, K=${loserKFactor})`
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
