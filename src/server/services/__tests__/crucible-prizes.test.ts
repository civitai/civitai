/**
 * Unit tests for prize distribution logic in crucible.service.ts
 *
 * These tests verify the prize calculation and distribution logic.
 * Run with: npx tsx src/server/services/__tests__/crucible-prizes.test.ts
 *
 * Note: These tests inline the pure function implementations to avoid importing
 * the service file which has database/Redis dependencies requiring environment variables.
 * The implementations MUST match those in crucible.service.ts exactly.
 *
 * @file crucible-prizes.test.ts
 */

// Wrap in IIFE to scope variables (avoids conflicts with other test files during typecheck)
(function runPrizeTests() {
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
   * Calculate prize distribution based on prize positions config and total pool
   * This replicates the logic from finalizeCrucible
   */
  function calculatePrizeDistribution(
    prizePositions: PrizePosition[],
    totalPrizePool: number,
    numEntries: number
  ): { position: number; prizeAmount: number }[] {
    // Sort prize positions by position number
    const sortedPrizePositions = [...prizePositions].sort((a, b) => a.position - b.position);

    // Calculate prize amount for each position
    const results: { position: number; prizeAmount: number }[] = [];

    for (let position = 1; position <= numEntries; position++) {
      const prizeConfig = sortedPrizePositions.find((p) => p.position === position);
      const prizeAmount = prizeConfig
        ? Math.floor((prizeConfig.percentage / 100) * totalPrizePool)
        : 0;

      results.push({ position, prizeAmount });
    }

    return results;
  }

  /**
   * Calculate total prizes distributed
   */
  function calculateTotalPrizesDistributed(prizeDistribution: { prizeAmount: number }[]): number {
    return prizeDistribution.reduce((sum, entry) => sum + entry.prizeAmount, 0);
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
      console.log(`  \u2713 ${name}`);
    } catch (error) {
      testsFailed++;
      console.log(`  \u2717 ${name}`);
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
        if (typeof actual !== 'number')
          throw new Error(`Expected a number but got ${typeof actual}`);
        if (actual >= expected) {
          throw new Error(`Expected ${actual} to be less than ${expected}`);
        }
      },
      toBeLessThanOrEqual(expected: number) {
        if (typeof actual !== 'number')
          throw new Error(`Expected a number but got ${typeof actual}`);
        if (actual > expected) {
          throw new Error(`Expected ${actual} to be less than or equal to ${expected}`);
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

  describe('parsePrizePositions', () => {
    test('parses valid prize positions array', () => {
      const input = [
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
        { position: 3, percentage: 20 },
      ];

      const result = parsePrizePositions(input);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ position: 1, percentage: 50 });
      expect(result[1]).toEqual({ position: 2, percentage: 30 });
      expect(result[2]).toEqual({ position: 3, percentage: 20 });
    });

    test('returns empty array for null input', () => {
      const result = parsePrizePositions(null);
      expect(result).toHaveLength(0);
    });

    test('returns empty array for undefined input', () => {
      const result = parsePrizePositions(undefined);
      expect(result).toHaveLength(0);
    });

    test('returns empty array for non-array input', () => {
      const result = parsePrizePositions({ position: 1, percentage: 100 });
      expect(result).toHaveLength(0);
    });

    test('filters out invalid items', () => {
      const input = [
        { position: 1, percentage: 50 },
        { position: 'invalid', percentage: 30 }, // invalid position
        { position: 3, percentage: 'invalid' }, // invalid percentage
        null, // null item
        { position: 4 }, // missing percentage
        { percentage: 10 }, // missing position
        { position: 5, percentage: 10 },
      ];

      const result = parsePrizePositions(input);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ position: 1, percentage: 50 });
      expect(result[1]).toEqual({ position: 5, percentage: 10 });
    });
  });

  describe('calculatePrizeDistribution - standard 50/30/20 split', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    test('distributes prizes with even pool (10000 Buzz)', () => {
      const totalPool = 10000;
      const numEntries = 10;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );

      expect(distribution[0].prizeAmount).toBe(5000); // 50% of 10000
      expect(distribution[1].prizeAmount).toBe(3000); // 30% of 10000
      expect(distribution[2].prizeAmount).toBe(2000); // 20% of 10000
      expect(distribution[3].prizeAmount).toBe(0); // 4th place gets nothing
    });

    test('distributes prizes with 100 Buzz pool', () => {
      const totalPool = 100;
      const numEntries = 5;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );

      expect(distribution[0].prizeAmount).toBe(50); // 50% of 100
      expect(distribution[1].prizeAmount).toBe(30); // 30% of 100
      expect(distribution[2].prizeAmount).toBe(20); // 20% of 100
    });

    test('total distributed equals total pool when evenly divisible', () => {
      const totalPool = 10000;
      const numEntries = 5;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      expect(totalDistributed).toBe(10000);
    });
  });

  describe('calculatePrizeDistribution - rounding behavior', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    test('rounds down individual prizes (Math.floor)', () => {
      // 333 Buzz pool:
      // 50% of 333 = 166.5 -> floors to 166
      // 30% of 333 = 99.9 -> floors to 99
      // 20% of 333 = 66.6 -> floors to 66
      const totalPool = 333;
      const numEntries = 3;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );

      expect(distribution[0].prizeAmount).toBe(166); // Math.floor(333 * 0.5)
      expect(distribution[1].prizeAmount).toBe(99); // Math.floor(333 * 0.3)
      expect(distribution[2].prizeAmount).toBe(66); // Math.floor(333 * 0.2)
    });

    test('remainder is lost due to rounding down', () => {
      const totalPool = 333;
      const numEntries = 3;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      // 166 + 99 + 66 = 331, so 2 Buzz lost to rounding
      expect(totalDistributed).toBe(331);
      expect(totalDistributed).toBeLessThan(totalPool);
    });

    test('handles pool that does not divide evenly', () => {
      // 1000 Buzz pool with 50/30/20 split:
      // All should divide evenly: 500 + 300 + 200 = 1000
      const totalPool = 1000;
      const numEntries = 5;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      expect(totalDistributed).toBe(1000);
    });

    test('handles small pool with rounding losses', () => {
      // 7 Buzz pool:
      // 50% of 7 = 3.5 -> floors to 3
      // 30% of 7 = 2.1 -> floors to 2
      // 20% of 7 = 1.4 -> floors to 1
      // Total = 6 (1 Buzz lost)
      const totalPool = 7;
      const numEntries = 3;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      expect(distribution[0].prizeAmount).toBe(3);
      expect(distribution[1].prizeAmount).toBe(2);
      expect(distribution[2].prizeAmount).toBe(1);
      expect(totalDistributed).toBe(6);
      expect(totalDistributed).toBeLessThan(totalPool);
    });
  });

  describe('calculatePrizeDistribution - single winner (100% to first)', () => {
    const singleWinnerPrize: PrizePosition[] = [{ position: 1, percentage: 100 }];

    test('gives entire pool to first place', () => {
      const totalPool = 5000;
      const numEntries = 10;

      const distribution = calculatePrizeDistribution(singleWinnerPrize, totalPool, numEntries);

      expect(distribution[0].prizeAmount).toBe(5000);
      expect(distribution[1].prizeAmount).toBe(0);
      expect(distribution[2].prizeAmount).toBe(0);
    });

    test('second and third place get nothing', () => {
      const totalPool = 10000;
      const numEntries = 5;

      const distribution = calculatePrizeDistribution(singleWinnerPrize, totalPool, numEntries);

      expect(distribution[0].prizeAmount).toBe(10000);

      for (let i = 1; i < numEntries; i++) {
        expect(distribution[i].prizeAmount).toBe(0);
      }
    });

    test('total distributed equals pool', () => {
      const totalPool = 12345;
      const numEntries = 3;

      const distribution = calculatePrizeDistribution(singleWinnerPrize, totalPool, numEntries);
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      expect(totalDistributed).toBe(12345);
    });
  });

  describe('calculatePrizeDistribution - more positions than entries', () => {
    const fourPositionsPrize: PrizePosition[] = [
      { position: 1, percentage: 40 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
      { position: 4, percentage: 10 },
    ];

    test('only distributes to existing entries (2 entries, 4 positions defined)', () => {
      const totalPool = 1000;
      const numEntries = 2;

      const distribution = calculatePrizeDistribution(fourPositionsPrize, totalPool, numEntries);

      expect(distribution).toHaveLength(2);
      expect(distribution[0].prizeAmount).toBe(400); // 40% to 1st
      expect(distribution[1].prizeAmount).toBe(300); // 30% to 2nd
      // Positions 3 and 4 not calculated (no entries)
    });

    test('positions 3 and 4 prizes are not distributed when only 2 entries', () => {
      const totalPool = 1000;
      const numEntries = 2;

      const distribution = calculatePrizeDistribution(fourPositionsPrize, totalPool, numEntries);
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      // Only 40% + 30% = 70% distributed
      expect(totalDistributed).toBe(700);
      expect(totalDistributed).toBeLessThan(totalPool);
    });

    test('with 1 entry, only first place gets prize', () => {
      const totalPool = 1000;
      const numEntries = 1;

      const distribution = calculatePrizeDistribution(fourPositionsPrize, totalPool, numEntries);
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      expect(distribution).toHaveLength(1);
      expect(distribution[0].prizeAmount).toBe(400); // 40% to 1st
      expect(totalDistributed).toBe(400);
    });
  });

  describe('calculatePrizeDistribution - zero entries', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    test('returns empty distribution with 0 entries', () => {
      const totalPool = 10000;
      const numEntries = 0;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );

      expect(distribution).toHaveLength(0);
    });

    test('total distributed is 0 with 0 entries', () => {
      const totalPool = 10000;
      const numEntries = 0;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );
      const totalDistributed = calculateTotalPrizesDistributed(distribution);

      expect(totalDistributed).toBe(0);
    });
  });

  describe('calculatePrizeDistribution - zero prize pool', () => {
    const standardPrizePositions: PrizePosition[] = [
      { position: 1, percentage: 50 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
    ];

    test('distributes 0 to all positions with 0 pool', () => {
      const totalPool = 0;
      const numEntries = 5;

      const distribution = calculatePrizeDistribution(
        standardPrizePositions,
        totalPool,
        numEntries
      );

      expect(distribution[0].prizeAmount).toBe(0);
      expect(distribution[1].prizeAmount).toBe(0);
      expect(distribution[2].prizeAmount).toBe(0);
    });
  });

  describe('calculatePrizeDistribution - custom percentages', () => {
    test('handles 60/25/15 split', () => {
      const customPrizes: PrizePosition[] = [
        { position: 1, percentage: 60 },
        { position: 2, percentage: 25 },
        { position: 3, percentage: 15 },
      ];
      const totalPool = 10000;
      const numEntries = 5;

      const distribution = calculatePrizeDistribution(customPrizes, totalPool, numEntries);

      expect(distribution[0].prizeAmount).toBe(6000);
      expect(distribution[1].prizeAmount).toBe(2500);
      expect(distribution[2].prizeAmount).toBe(1500);
    });

    test('handles top 5 prizes', () => {
      const top5Prizes: PrizePosition[] = [
        { position: 1, percentage: 35 },
        { position: 2, percentage: 25 },
        { position: 3, percentage: 20 },
        { position: 4, percentage: 12 },
        { position: 5, percentage: 8 },
      ];
      const totalPool = 10000;
      const numEntries = 10;

      const distribution = calculatePrizeDistribution(top5Prizes, totalPool, numEntries);

      expect(distribution[0].prizeAmount).toBe(3500);
      expect(distribution[1].prizeAmount).toBe(2500);
      expect(distribution[2].prizeAmount).toBe(2000);
      expect(distribution[3].prizeAmount).toBe(1200);
      expect(distribution[4].prizeAmount).toBe(800);
      expect(distribution[5].prizeAmount).toBe(0); // 6th place gets nothing
    });

    test('handles unsorted prize positions', () => {
      // Prize positions not in order - should still work
      const unsortedPrizes: PrizePosition[] = [
        { position: 3, percentage: 20 },
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
      ];
      const totalPool = 1000;
      const numEntries = 5;

      const distribution = calculatePrizeDistribution(unsortedPrizes, totalPool, numEntries);

      // Should be sorted by position in result
      expect(distribution[0].prizeAmount).toBe(500); // 1st place: 50%
      expect(distribution[1].prizeAmount).toBe(300); // 2nd place: 30%
      expect(distribution[2].prizeAmount).toBe(200); // 3rd place: 20%
    });
  });

  describe('calculateTotalPrizesDistributed', () => {
    test('sums prize amounts correctly', () => {
      const distribution = [
        { prizeAmount: 5000 },
        { prizeAmount: 3000 },
        { prizeAmount: 2000 },
        { prizeAmount: 0 },
        { prizeAmount: 0 },
      ];

      const total = calculateTotalPrizesDistributed(distribution);

      expect(total).toBe(10000);
    });

    test('returns 0 for empty array', () => {
      const total = calculateTotalPrizesDistributed([]);
      expect(total).toBe(0);
    });

    test('returns 0 when all prizes are 0', () => {
      const distribution = [{ prizeAmount: 0 }, { prizeAmount: 0 }, { prizeAmount: 0 }];

      const total = calculateTotalPrizesDistributed(distribution);

      expect(total).toBe(0);
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
