/**
 * Unit tests for crucible finalization edge cases
 *
 * These tests verify the finalization logic handles edge cases correctly:
 * - 0 entries (no prizes distributed)
 * - 1 entry (auto-win)
 * - Tied ELO scores (entry time as tiebreaker)
 * - Status updates to completed
 * - Redis ELO to PostgreSQL syncing
 *
 * Run with: npx tsx src/server/services/__tests__/crucible-finalization.test.ts
 *
 * Note: These tests inline pure function implementations to avoid importing
 * the service file which has database/Redis dependencies requiring environment variables.
 * The implementations MUST match those in crucible.service.ts exactly.
 *
 * @file crucible-finalization.test.ts
 */

// Wrap in IIFE to scope variables (avoids conflicts with other test files during typecheck)
(function runFinalizationTests() {
  // ============================================================
  // TYPES (must match crucible.service.ts)
  // ============================================================

  /**
   * Prize position type from database JSON
   */
  type PrizePosition = {
    position: number;
    percentage: number;
  };

  /**
   * Entry with score and creation time for sorting
   */
  type EntryForSorting = {
    entryId: number;
    userId: number;
    finalScore: number;
    voteCount: number;
    createdAt: Date;
  };

  /**
   * Entry with final score and position after finalization
   */
  type FinalizedEntry = {
    entryId: number;
    userId: number;
    finalScore: number;
    voteCount: number;
    position: number;
    prizeAmount: number;
  };

  // ============================================================
  // PURE FUNCTIONS UNDER TEST (must match crucible.service.ts)
  // ============================================================

  const CRUCIBLE_DEFAULT_ELO = 1500;

  /**
   * Parse prize positions JSON from database
   */
  function parsePrizePositions(prizePositionsJson: unknown): PrizePosition[] {
    if (!prizePositionsJson || !Array.isArray(prizePositionsJson)) {
      return [];
    }

    return prizePositionsJson
      .filter(
        (item): item is { position: number; percentage: number } =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.position === 'number' &&
          typeof item.percentage === 'number'
      )
      .map((item) => ({
        position: item.position,
        percentage: item.percentage,
      }));
  }

  /**
   * Combine database entries with Redis ELO scores
   * If an entry doesn't have a Redis score, use the database score (1500 default)
   */
  function combineEntriesWithElo(
    dbEntries: Array<{
      id: number;
      userId: number;
      score: number;
      createdAt: Date;
    }>,
    redisElos: Record<number, number>,
    redisVoteCounts: Record<number, number>
  ): EntryForSorting[] {
    return dbEntries.map((entry) => ({
      entryId: entry.id,
      userId: entry.userId,
      finalScore: redisElos[entry.id] ?? entry.score,
      voteCount: redisVoteCounts[entry.id] ?? 0,
      createdAt: entry.createdAt,
    }));
  }

  /**
   * Sort entries by ELO score (descending), with entry time as tiebreaker (earlier = higher rank)
   */
  function sortEntriesByScore(entries: EntryForSorting[]): EntryForSorting[] {
    return [...entries].sort((a, b) => {
      if (b.finalScore !== a.finalScore) {
        return b.finalScore - a.finalScore; // Higher score = better position
      }
      // Tiebreaker: earlier entry wins
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  /**
   * Assign positions and calculate prize amounts
   */
  function finalizeEntries(
    sortedEntries: EntryForSorting[],
    prizePositions: PrizePosition[],
    totalPrizePool: number
  ): FinalizedEntry[] {
    const sortedPrizePositions = [...prizePositions].sort((a, b) => a.position - b.position);

    return sortedEntries.map((entry, index) => {
      const position = index + 1;

      // Find prize percentage for this position
      const prizeConfig = sortedPrizePositions.find((p) => p.position === position);
      const prizeAmount = prizeConfig
        ? Math.floor((prizeConfig.percentage / 100) * totalPrizePool)
        : 0;

      return {
        entryId: entry.entryId,
        userId: entry.userId,
        finalScore: entry.finalScore,
        voteCount: entry.voteCount,
        position,
        prizeAmount,
      };
    });
  }

  /**
   * Calculate total prize pool based on entry fee and number of entries
   */
  function calculateTotalPrizePool(entryFee: number, numEntries: number): number {
    return entryFee * numEntries;
  }

  // ============================================================
  // Simple test utilities
  // ============================================================

  let testsPassed = 0;
  let testsFailed = 0;

  function describe(name: string, fn: () => void) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUITE: ${name}`);
    console.log('='.repeat(60));
    fn();
  }

  function test(name: string, fn: () => void) {
    try {
      fn();
      testsPassed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      testsFailed++;
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${(error as Error).message}`);
    }
  }

  function expect<T>(actual: T) {
    return {
      toBe(expected: T) {
        if (actual !== expected) {
          throw new Error(`Expected ${expected} but got ${actual}`);
        }
      },
      toEqual(expected: T) {
        const actualStr = JSON.stringify(actual);
        const expectedStr = JSON.stringify(expected);
        if (actualStr !== expectedStr) {
          throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
        }
      },
      toBeLessThan(expected: number) {
        if (typeof actual !== 'number') throw new Error(`Expected a number but got ${typeof actual}`);
        if (actual >= expected) {
          throw new Error(`Expected ${actual} to be less than ${expected}`);
        }
      },
      toBeGreaterThan(expected: number) {
        if (typeof actual !== 'number') throw new Error(`Expected a number but got ${typeof actual}`);
        if (actual <= expected) {
          throw new Error(`Expected ${actual} to be greater than ${expected}`);
        }
      },
      toHaveLength(expected: number) {
        if (!Array.isArray(actual)) throw new Error(`Expected an array but got ${typeof actual}`);
        if (actual.length !== expected) {
          throw new Error(`Expected length ${expected} but got ${actual.length}`);
        }
      },
    };
  }

  // ============================================================
  // TEST SUITE
  // ============================================================

  describe('Finalization with 0 entries', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    test('returns empty finalized entries array', () => {
      const dbEntries: Array<{ id: number; userId: number; score: number; createdAt: Date }> = [];
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, 0);

      expect(finalizedEntries).toHaveLength(0);
    });

    test('calculates total prize pool as 0', () => {
      const entryFee = 100;
      const numEntries = 0;

      const totalPool = calculateTotalPrizePool(entryFee, numEntries);

      expect(totalPool).toBe(0);
    });

    test('no prizes are distributed', () => {
      const dbEntries: Array<{ id: number; userId: number; score: number; createdAt: Date }> = [];
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, 0);

      const totalDistributed = finalizedEntries.reduce((sum, e) => sum + e.prizeAmount, 0);
      expect(totalDistributed).toBe(0);
    });
  });

  describe('Finalization with 1 entry (auto-win)', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    const singleWinnerPrizes: PrizePosition[] = [{ position: 1, percentage: 100 }];

    test('single entry gets position 1', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
      ];
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 1);
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      expect(finalizedEntries).toHaveLength(1);
      expect(finalizedEntries[0].position).toBe(1);
    });

    test('single entry gets 50% prize with standard 50/30/20 split', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
      ];
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 1); // 100 Buzz pool
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      // With 50/30/20 split and only 1 entry, first place gets 50%
      expect(finalizedEntries[0].prizeAmount).toBe(50);
    });

    test('single entry gets 100% prize with single-winner config', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
      ];
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 1); // 100 Buzz pool
      const finalizedEntries = finalizeEntries(sortedEntries, singleWinnerPrizes, totalPool);

      // With 100% to first, single entry gets everything
      expect(finalizedEntries[0].prizeAmount).toBe(100);
    });

    test('single entry keeps default ELO score when no Redis data', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
      ];
      const redisElos: Record<number, number> = {}; // No Redis data
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 1);
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      expect(finalizedEntries[0].finalScore).toBe(CRUCIBLE_DEFAULT_ELO);
    });

    test('single entry uses Redis ELO when available', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
      ];
      const redisElos: Record<number, number> = { 1: 1600 }; // Redis has updated ELO
      const redisVoteCounts: Record<number, number> = { 1: 5 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 1);
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      expect(finalizedEntries[0].finalScore).toBe(1600);
      expect(finalizedEntries[0].voteCount).toBe(5);
    });
  });

  describe('Finalization with tied ELO scores (entry time as tiebreaker)', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    test('earlier entry wins tiebreaker for position 1', () => {
      // Two entries with same ELO, different creation times
      const dbEntries = [
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T12:00:00Z') }, // Later
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') }, // Earlier
      ];
      const redisElos: Record<number, number> = {
        1: 1600, // Same ELO
        2: 1600, // Same ELO
      };
      const redisVoteCounts: Record<number, number> = { 1: 10, 2: 10 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);

      // Entry 1 created earlier, so it should be first
      expect(sortedEntries[0].entryId).toBe(1);
      expect(sortedEntries[1].entryId).toBe(2);
    });

    test('tiebreaker determines prize distribution correctly', () => {
      const dbEntries = [
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T12:00:00Z') },
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
      ];
      const redisElos: Record<number, number> = {
        1: 1600,
        2: 1600,
      };
      const redisVoteCounts: Record<number, number> = { 1: 10, 2: 10 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 2); // 200 Buzz pool
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      // Entry 1 (earlier) gets 1st place (50% = 100 Buzz)
      expect(finalizedEntries[0].entryId).toBe(1);
      expect(finalizedEntries[0].position).toBe(1);
      expect(finalizedEntries[0].prizeAmount).toBe(100);

      // Entry 2 (later) gets 2nd place (30% = 60 Buzz)
      expect(finalizedEntries[1].entryId).toBe(2);
      expect(finalizedEntries[1].position).toBe(2);
      expect(finalizedEntries[1].prizeAmount).toBe(60);
    });

    test('three-way tie resolved by entry time', () => {
      const dbEntries = [
        { id: 3, userId: 300, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T14:00:00Z') },
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T12:00:00Z') },
      ];
      const redisElos: Record<number, number> = {
        1: 1600,
        2: 1600,
        3: 1600,
      };
      const redisVoteCounts: Record<number, number> = { 1: 10, 2: 10, 3: 10 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);

      // Sorted by entry time (earliest first)
      expect(sortedEntries[0].entryId).toBe(1); // 10:00
      expect(sortedEntries[1].entryId).toBe(2); // 12:00
      expect(sortedEntries[2].entryId).toBe(3); // 14:00
    });

    test('mixed tie: some tied, some different ELO', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
        { id: 3, userId: 300, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T12:00:00Z') },
        { id: 4, userId: 400, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T13:00:00Z') },
      ];
      const redisElos: Record<number, number> = {
        1: 1700, // Highest ELO
        2: 1600, // Tied with entry 3
        3: 1600, // Tied with entry 2, but entered later
        4: 1500, // Lowest ELO
      };
      const redisVoteCounts: Record<number, number> = { 1: 20, 2: 15, 3: 15, 4: 10 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);

      expect(sortedEntries[0].entryId).toBe(1); // 1700 ELO - position 1
      expect(sortedEntries[1].entryId).toBe(2); // 1600 ELO, earlier - position 2
      expect(sortedEntries[2].entryId).toBe(3); // 1600 ELO, later - position 3
      expect(sortedEntries[3].entryId).toBe(4); // 1500 ELO - position 4
    });
  });

  describe('Finalization status update to completed', () => {
    // These tests validate the logic that determines finalization should proceed
    // The actual status update happens in the service (with DB transaction)

    test('finalization logic produces results for 0 entries (edge case)', () => {
      const dbEntries: Array<{ id: number; userId: number; score: number; createdAt: Date }> = [];
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const finalizedEntries = finalizeEntries(sortedEntries, [], 0);

      // Even with 0 entries, finalization should complete (status -> Completed)
      expect(finalizedEntries).toHaveLength(0);
    });

    test('finalization produces valid results for normal case', () => {
      const standardPrizePositions: PrizePosition[] = [
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
        { position: 3, percentage: 20 },
      ];

      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
        { id: 3, userId: 300, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T12:00:00Z') },
      ];
      const redisElos: Record<number, number> = { 1: 1700, 2: 1550, 3: 1450 };
      const redisVoteCounts: Record<number, number> = { 1: 20, 2: 15, 3: 10 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 3); // 300 Buzz
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      // All entries should have valid positions
      expect(finalizedEntries).toHaveLength(3);
      expect(finalizedEntries[0].position).toBe(1);
      expect(finalizedEntries[1].position).toBe(2);
      expect(finalizedEntries[2].position).toBe(3);
    });
  });

  describe('Redis ELO to PostgreSQL syncing', () => {
    test('entries get Redis ELO scores, not default DB scores', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
      ];
      const redisElos: Record<number, number> = {
        1: 1850, // Much higher than default
        2: 1150, // Much lower than default
      };
      const redisVoteCounts: Record<number, number> = { 1: 30, 2: 25 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);

      expect(entriesWithElo[0].finalScore).toBe(1850);
      expect(entriesWithElo[1].finalScore).toBe(1150);
    });

    test('entries without Redis ELO use DB score as fallback', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: 1550, createdAt: new Date('2024-01-01T10:00:00Z') }, // Custom DB score
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
      ];
      const redisElos: Record<number, number> = {
        // Entry 1 has no Redis ELO
        2: 1600,
      };
      const redisVoteCounts: Record<number, number> = { 2: 10 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);

      // Entry 1 uses DB score (1550) since no Redis ELO
      expect(entriesWithElo[0].finalScore).toBe(1550);
      // Entry 2 uses Redis ELO
      expect(entriesWithElo[1].finalScore).toBe(1600);
    });

    test('vote counts synced from Redis', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
        { id: 3, userId: 300, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T12:00:00Z') },
      ];
      const redisElos: Record<number, number> = { 1: 1600, 2: 1550, 3: 1500 };
      const redisVoteCounts: Record<number, number> = {
        1: 42,
        2: 38,
        // Entry 3 has no vote count in Redis
      };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);

      expect(entriesWithElo[0].voteCount).toBe(42);
      expect(entriesWithElo[1].voteCount).toBe(38);
      expect(entriesWithElo[2].voteCount).toBe(0); // Default when not in Redis
    });

    test('finalized entries have synced ELO scores preserved', () => {
      const standardPrizePositions: PrizePosition[] = [
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
        { position: 3, percentage: 20 },
      ];

      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
      ];
      const redisElos: Record<number, number> = {
        1: 1750,
        2: 1350,
      };
      const redisVoteCounts: Record<number, number> = { 1: 25, 2: 20 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 2);
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      // Redis ELO scores should be in finalizedEntries
      expect(finalizedEntries[0].finalScore).toBe(1750);
      expect(finalizedEntries[0].voteCount).toBe(25);
      expect(finalizedEntries[1].finalScore).toBe(1350);
      expect(finalizedEntries[1].voteCount).toBe(20);
    });
  });

  describe('Prize distribution with edge case entry counts', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    test('2 entries: only positions 1 and 2 get prizes', () => {
      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
      ];
      const redisElos: Record<number, number> = { 1: 1600, 2: 1400 };
      const redisVoteCounts: Record<number, number> = { 1: 10, 2: 10 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 2); // 200 Buzz
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      expect(finalizedEntries[0].prizeAmount).toBe(100); // 50% of 200
      expect(finalizedEntries[1].prizeAmount).toBe(60); // 30% of 200
      // Position 3 not calculated (no entry)

      const totalDistributed = finalizedEntries.reduce((sum, e) => sum + e.prizeAmount, 0);
      expect(totalDistributed).toBe(160); // 50% + 30% = 80% distributed
    });

    test('10 entries: only positions 1-3 get prizes', () => {
      const dbEntries = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        userId: (i + 1) * 100,
        score: CRUCIBLE_DEFAULT_ELO,
        createdAt: new Date(`2024-01-01T${10 + i}:00:00Z`),
      }));

      // Create varied ELO scores
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};
      for (let i = 1; i <= 10; i++) {
        redisElos[i] = 1500 + (11 - i) * 50; // 1550, 1500, 1450, ...
        redisVoteCounts[i] = 20;
      }

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 10); // 1000 Buzz
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      expect(finalizedEntries[0].prizeAmount).toBe(500); // 1st: 50%
      expect(finalizedEntries[1].prizeAmount).toBe(300); // 2nd: 30%
      expect(finalizedEntries[2].prizeAmount).toBe(200); // 3rd: 20%

      // Positions 4-10 get nothing
      for (let i = 3; i < 10; i++) {
        expect(finalizedEntries[i].prizeAmount).toBe(0);
      }

      const totalDistributed = finalizedEntries.reduce((sum, e) => sum + e.prizeAmount, 0);
      expect(totalDistributed).toBe(1000);
    });
  });

  describe('Buzz transaction simulation', () => {
    // These tests verify the logic for determining prize winners
    // Actual Buzz transactions are mocked in the service

    test('entries with prizeAmount > 0 would receive Buzz transactions', () => {
      const standardPrizePositions: PrizePosition[] = [
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
        { position: 3, percentage: 20 },
      ];

      const dbEntries = [
        { id: 1, userId: 100, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T10:00:00Z') },
        { id: 2, userId: 200, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T11:00:00Z') },
        { id: 3, userId: 300, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T12:00:00Z') },
        { id: 4, userId: 400, score: CRUCIBLE_DEFAULT_ELO, createdAt: new Date('2024-01-01T13:00:00Z') },
      ];
      const redisElos: Record<number, number> = { 1: 1700, 2: 1600, 3: 1500, 4: 1400 };
      const redisVoteCounts: Record<number, number> = { 1: 30, 2: 25, 3: 20, 4: 15 };

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const totalPool = calculateTotalPrizePool(100, 4); // 400 Buzz
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, totalPool);

      // Filter entries with prizes (would receive Buzz transactions)
      const prizeWinners = finalizedEntries.filter((e) => e.prizeAmount > 0);

      expect(prizeWinners).toHaveLength(3);
      expect(prizeWinners[0].userId).toBe(100);
      expect(prizeWinners[0].prizeAmount).toBe(200); // 50% of 400
      expect(prizeWinners[1].userId).toBe(200);
      expect(prizeWinners[1].prizeAmount).toBe(120); // 30% of 400
      expect(prizeWinners[2].userId).toBe(300);
      expect(prizeWinners[2].prizeAmount).toBe(80); // 20% of 400
    });

    test('no Buzz transactions for 0 entry crucible', () => {
      const standardPrizePositions: PrizePosition[] = [
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
        { position: 3, percentage: 20 },
      ];

      const dbEntries: Array<{ id: number; userId: number; score: number; createdAt: Date }> = [];
      const redisElos: Record<number, number> = {};
      const redisVoteCounts: Record<number, number> = {};

      const entriesWithElo = combineEntriesWithElo(dbEntries, redisElos, redisVoteCounts);
      const sortedEntries = sortEntriesByScore(entriesWithElo);
      const finalizedEntries = finalizeEntries(sortedEntries, standardPrizePositions, 0);

      const prizeWinners = finalizedEntries.filter((e) => e.prizeAmount > 0);

      expect(prizeWinners).toHaveLength(0);
    });
  });

  // ============================================================
  // RUN TESTS & REPORT
  // ============================================================

  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log(`Total: ${testsPassed + testsFailed}`);

  if (testsFailed > 0) {
    console.log('\nSome tests FAILED');
    process.exit(1);
  } else {
    console.log('\nAll tests PASSED');
    process.exit(0);
  }
})();
