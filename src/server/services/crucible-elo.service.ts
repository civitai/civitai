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
 * Calculate the ELO rating change after a match
 * Based on the standard ELO formula:
 * - Expected score: Ea = 1 / (1 + 10^((Rb - Ra) / 400))
 * - New rating: Ra' = Ra + K * (Sa - Ea)
 *
 * @param winnerElo - Current ELO of the winner
 * @param loserElo - Current ELO of the loser
 * @param kFactor - K-factor to use (default: 32)
 * @returns [winnerChange, loserChange] - The change in ELO for winner (positive) and loser (negative)
 */
export const calculateEloChange = (
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
  const winnerChange = Math.round(kFactor * (actualWinner - expectedWinner));
  const loserChange = Math.round(kFactor * (actualLoser - expectedLoser));

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
 * Process a vote by updating ELO scores in Redis
 * Uses the average of both entries' K-factors for balanced rating changes
 *
 * PERFORMANCE: Uses Promise.all for parallel Redis operations
 * - Round-trip 1: Get both ELO scores in parallel
 * - Round-trip 2: Update both ELO scores in parallel (incrementElo or initialize+set)
 * Total: 2 round-trips maximum (down from 4-6)
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
  // Get current ELO scores from Redis in parallel (1 effective round-trip)
  const [winnerEloRaw, loserEloRaw] = await Promise.all([
    crucibleEloRedis.getElo(crucibleId, winnerEntryId),
    crucibleEloRedis.getElo(crucibleId, loserEntryId),
  ]);

  // Use default ELO if not set (entries should have ELO set on submission, but be defensive)
  const winnerElo = winnerEloRaw ?? CRUCIBLE_DEFAULT_ELO;
  const loserElo = loserEloRaw ?? CRUCIBLE_DEFAULT_ELO;

  // Calculate K-factor (use average of both entries' K-factors for fairness)
  const winnerKFactor = getKFactor(winnerVoteCount);
  const loserKFactor = getKFactor(loserVoteCount);
  const kFactor = Math.round((winnerKFactor + loserKFactor) / 2);

  // Calculate ELO changes
  const [winnerChange, loserChange] = calculateEloChange(winnerElo, loserElo, kFactor);

  // Update Redis in parallel (1 effective round-trip)
  // For entries without ELO in Redis, we set the new ELO directly instead of incrementing
  const [newWinnerElo, newLoserElo] = await Promise.all([
    winnerEloRaw === null
      ? crucibleEloRedis.setElo(crucibleId, winnerEntryId, winnerElo + winnerChange).then(
          () => winnerElo + winnerChange
        )
      : crucibleEloRedis.incrementElo(crucibleId, winnerEntryId, winnerChange),
    loserEloRaw === null
      ? crucibleEloRedis.setElo(crucibleId, loserEntryId, loserElo + loserChange).then(
          () => loserElo + loserChange
        )
      : crucibleEloRedis.incrementElo(crucibleId, loserEntryId, loserChange),
  ]);

  log(
    `Vote processed: crucible ${crucibleId}, winner ${winnerEntryId} (${winnerElo} + ${winnerChange} = ${newWinnerElo}), loser ${loserEntryId} (${loserElo} + ${loserChange} = ${newLoserElo}), K=${kFactor}`
  );

  return {
    winnerElo: newWinnerElo,
    loserElo: newLoserElo,
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
export { CRUCIBLE_DEFAULT_ELO, K_FACTOR_PROVISIONAL, K_FACTOR_ESTABLISHED, PROVISIONAL_VOTE_THRESHOLD };
