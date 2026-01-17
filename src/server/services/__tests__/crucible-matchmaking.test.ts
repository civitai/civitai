/**
 * Unit tests for crucible matchmaking/judging pair selection logic
 *
 * These tests verify the matchmaking algorithm that selects image pairs for judging.
 * Run with: npx tsx src/server/services/__tests__/crucible-matchmaking.test.ts
 *
 * Note: These tests inline the pure function implementations to avoid importing
 * the service file which has Redis/database dependencies requiring environment variables.
 * The implementations MUST match those in crucible.service.ts exactly.
 *
 * @file crucible-matchmaking.test.ts
 */

// Wrap in IIFE to scope variables (avoids conflicts with other test files during typecheck)
(function runMatchmakingTests() {
  // ============================================================
  // CONSTANTS (must match crucible.service.ts)
  // ============================================================
  const CRUCIBLE_DEFAULT_ELO = 1500;
  const ELO_DEVIATION_LOW = 50; // 0-50 ELO deviation: calibration phase
  const ELO_DEVIATION_MED = 150; // 50-150 ELO deviation: discovery phase
  // >150 ELO deviation: optimization phase

  // ============================================================
  // TYPE DEFINITIONS (must match crucible.service.ts)
  // ============================================================
  type EntryForJudging = {
    id: number;
    imageId: number;
    userId: number;
    score: number;
    image: {
      id: number;
      url: string;
      width: number | null;
      height: number | null;
      nsfwLevel: number;
    };
    user: {
      id: number;
      username: string | null;
      deletedAt: Date | null;
      image: string | null;
    };
  };

  // ============================================================
  // PURE FUNCTIONS UNDER TEST (must match crucible.service.ts)
  // ============================================================

  /**
   * Estimate vote activity based on ELO deviation from default
   * Entries closer to 1500 have likely received fewer votes
   */
  function getEloDeviation(score: number): number {
    return Math.abs(score - CRUCIBLE_DEFAULT_ELO);
  }

  /**
   * Determine the voting phase based on ELO deviation
   */
  function getVotingPhase(deviation: number): 'calibration' | 'discovery' | 'optimization' {
    if (deviation <= ELO_DEVIATION_LOW) {
      return 'calibration';
    } else if (deviation <= ELO_DEVIATION_MED) {
      return 'discovery';
    } else {
      return 'optimization';
    }
  }

  /**
   * Get candidate pool for Image B based on voting phase
   * Note: Does NOT filter by voted pairs - that check happens asynchronously via SISMEMBER
   */
  function getCandidateBPool(
    entries: EntryForJudging[],
    imageA: EntryForJudging,
    phase: 'calibration' | 'discovery' | 'optimization'
  ): EntryForJudging[] {
    // Filter out Image A only - voted pair check happens asynchronously
    const validCandidates = entries.filter((entry) => entry.id !== imageA.id);

    if (validCandidates.length === 0) return [];

    switch (phase) {
      case 'calibration': {
        // Anchor: Pick entries with high ELO deviation (established ratings)
        // These serve as reference points for new entries
        const highDeviationEntries = validCandidates.filter(
          (entry) => getEloDeviation(entry.score) > ELO_DEVIATION_LOW
        );
        // If no high-deviation entries available, fall back to any available entries
        return highDeviationEntries.length > 0 ? highDeviationEntries : validCandidates;
      }

      case 'discovery': {
        // Uncertain: Pick entries with similar uncertain ELO
        // Find entries within 200 ELO points and similar deviation range
        const imageAElo = imageA.score;

        const uncertainEntries = validCandidates.filter((entry) => {
          const eloDiff = Math.abs(imageAElo - entry.score);
          const entryDeviation = getEloDeviation(entry.score);
          // Wide ELO range (200) and similar phase entries
          return (
            eloDiff <= 200 &&
            entryDeviation >= ELO_DEVIATION_LOW &&
            entryDeviation <= ELO_DEVIATION_MED * 2
          );
        });
        // Fall back to any available if no similar entries
        return uncertainEntries.length > 0 ? uncertainEntries : validCandidates;
      }

      case 'optimization': {
        // Similar ELO: Pick entries with similar ELO for fine-tuning rankings
        const imageAElo = imageA.score;

        // Narrow ELO range (100) for optimization
        let similarEloEntries = validCandidates.filter((entry) => {
          const eloDiff = Math.abs(imageAElo - entry.score);
          return eloDiff <= 100;
        });

        // If no similar ELO entries, expand to 200 range
        if (similarEloEntries.length === 0) {
          similarEloEntries = validCandidates.filter((entry) => {
            const eloDiff = Math.abs(imageAElo - entry.score);
            return eloDiff <= 200;
          });
        }

        return similarEloEntries.length > 0 ? similarEloEntries : validCandidates;
      }
    }
  }

  /**
   * Create a canonical pair key (always sorted so a:b == b:a)
   */
  function createPairKey(entryId1: number, entryId2: number): string {
    const [smaller, larger] = entryId1 < entryId2 ? [entryId1, entryId2] : [entryId2, entryId1];
    return `${smaller}:${larger}`;
  }

  // ============================================================
  // TEST UTILITIES
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
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
        }
      },
      toBeGreaterThan(expected: number) {
        if (typeof actual !== 'number')
          throw new Error(`Expected a number but got ${typeof actual}`);
        if (actual <= expected) {
          throw new Error(`Expected ${actual} to be greater than ${expected}`);
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
        const arr = actual as unknown as unknown[];
        if (!Array.isArray(arr)) throw new Error(`Expected an array but got ${typeof actual}`);
        if (arr.length !== expected) {
          throw new Error(`Expected array of length ${expected} but got ${arr.length}`);
        }
      },
      toContain(expected: unknown) {
        const arr = actual as unknown as unknown[];
        if (!Array.isArray(arr)) throw new Error(`Expected an array but got ${typeof actual}`);
        const found = arr.some(
          (item) =>
            item === expected ||
            (typeof item === 'object' &&
              item !== null &&
              'id' in (item as object) &&
              (item as { id: unknown }).id === expected)
        );
        if (!found) {
          throw new Error(`Expected array to contain ${expected}`);
        }
      },
      toNotContain(expected: unknown) {
        const arr = actual as unknown as unknown[];
        if (!Array.isArray(arr)) throw new Error(`Expected an array but got ${typeof actual}`);
        const found = arr.some(
          (item) =>
            item === expected ||
            (typeof item === 'object' &&
              item !== null &&
              'id' in (item as object) &&
              (item as { id: unknown }).id === expected)
        );
        if (found) {
          throw new Error(`Expected array to NOT contain ${expected}`);
        }
      },
      toBeEmpty() {
        const arr = actual as unknown as unknown[];
        if (!Array.isArray(arr)) throw new Error(`Expected an array but got ${typeof actual}`);
        if (arr.length !== 0) {
          throw new Error(`Expected empty array but got ${arr.length} items`);
        }
      },
    };
  }

  // ============================================================
  // HELPER: Create mock entry for testing
  // ============================================================
  function createMockEntry(id: number, score: number, userId?: number): EntryForJudging {
    return {
      id,
      imageId: id * 100,
      userId: userId ?? id,
      score,
      image: {
        id: id * 100,
        url: `https://example.com/image${id}.jpg`,
        width: 512,
        height: 512,
        nsfwLevel: 1,
      },
      user: {
        id: userId ?? id,
        username: `user${userId ?? id}`,
        deletedAt: null,
        image: null,
      },
    };
  }

  // ============================================================
  // TEST SUITES
  // ============================================================

  describe('getEloDeviation', () => {
    test('returns 0 for default ELO (1500)', () => {
      expect(getEloDeviation(1500)).toBe(0);
    });

    test('returns positive deviation for ELO above 1500', () => {
      expect(getEloDeviation(1600)).toBe(100);
      expect(getEloDeviation(1700)).toBe(200);
    });

    test('returns positive deviation for ELO below 1500', () => {
      expect(getEloDeviation(1400)).toBe(100);
      expect(getEloDeviation(1300)).toBe(200);
    });

    test('calculates correct deviation at phase boundaries', () => {
      // Calibration boundary (0-50)
      expect(getEloDeviation(1450)).toBe(50);
      expect(getEloDeviation(1550)).toBe(50);

      // Discovery boundary (50-150)
      expect(getEloDeviation(1350)).toBe(150);
      expect(getEloDeviation(1650)).toBe(150);
    });
  });

  describe('getVotingPhase', () => {
    test('returns "calibration" for deviation 0-50', () => {
      expect(getVotingPhase(0)).toBe('calibration');
      expect(getVotingPhase(25)).toBe('calibration');
      expect(getVotingPhase(50)).toBe('calibration');
    });

    test('returns "discovery" for deviation 51-150', () => {
      expect(getVotingPhase(51)).toBe('discovery');
      expect(getVotingPhase(100)).toBe('discovery');
      expect(getVotingPhase(150)).toBe('discovery');
    });

    test('returns "optimization" for deviation > 150', () => {
      expect(getVotingPhase(151)).toBe('optimization');
      expect(getVotingPhase(200)).toBe('optimization');
      expect(getVotingPhase(500)).toBe('optimization');
    });

    test('boundary: 50 is calibration, 51 is discovery', () => {
      expect(getVotingPhase(ELO_DEVIATION_LOW)).toBe('calibration');
      expect(getVotingPhase(ELO_DEVIATION_LOW + 1)).toBe('discovery');
    });

    test('boundary: 150 is discovery, 151 is optimization', () => {
      expect(getVotingPhase(ELO_DEVIATION_MED)).toBe('discovery');
      expect(getVotingPhase(ELO_DEVIATION_MED + 1)).toBe('optimization');
    });
  });

  describe('getCandidateBPool - Calibration Phase (anchor selection)', () => {
    test('selects high-deviation entries as anchors for calibration', () => {
      // Entry with low deviation (needs calibration)
      const imageA = createMockEntry(1, 1500); // Deviation: 0 (calibration)

      // Pool with mixed deviations
      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1500), // Deviation: 0 (calibration)
        createMockEntry(3, 1520), // Deviation: 20 (calibration)
        createMockEntry(4, 1600), // Deviation: 100 (discovery)
        createMockEntry(5, 1700), // Deviation: 200 (optimization - anchor)
        createMockEntry(6, 1300), // Deviation: 200 (optimization - anchor)
      ];

      const pool = getCandidateBPool(entries, imageA, 'calibration');

      // Should only include high-deviation entries (anchors)
      expect(pool).toNotContain(1); // imageA excluded
      expect(pool).toNotContain(2); // Low deviation excluded
      expect(pool).toNotContain(3); // Low deviation excluded
      expect(pool).toContain(4); // High deviation included
      expect(pool).toContain(5); // High deviation included
      expect(pool).toContain(6); // High deviation included
    });

    test('falls back to all entries if no high-deviation entries available', () => {
      const imageA = createMockEntry(1, 1500);

      // All entries have low deviation
      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1510), // Deviation: 10
        createMockEntry(3, 1490), // Deviation: 10
      ];

      const pool = getCandidateBPool(entries, imageA, 'calibration');

      // Should fall back to all entries (except imageA)
      expect(pool).toHaveLength(2);
      expect(pool).toContain(2);
      expect(pool).toContain(3);
    });
  });

  describe('getCandidateBPool - Discovery Phase (uncertain selection)', () => {
    test('selects entries within 200 ELO and medium deviation range', () => {
      // Entry in discovery phase
      const imageA = createMockEntry(1, 1580); // Deviation: 80 (discovery)

      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1600), // Deviation: 100, diff: 20 - MATCH
        createMockEntry(3, 1400), // Deviation: 100, diff: 180 - MATCH
        createMockEntry(4, 1850), // Deviation: 350, diff: 270 - too far ELO
        createMockEntry(5, 1500), // Deviation: 0, diff: 80 - too low deviation
        createMockEntry(6, 1550), // Deviation: 50, diff: 30 - MATCH (boundary)
      ];

      const pool = getCandidateBPool(entries, imageA, 'discovery');

      expect(pool).toContain(2); // Within 200 ELO and medium deviation
      expect(pool).toContain(3); // Within 200 ELO and medium deviation
      expect(pool).toNotContain(4); // Too far ELO (270 > 200)
      expect(pool).toNotContain(5); // Deviation too low (0 < 50)
      expect(pool).toContain(6); // Boundary case: deviation exactly 50
    });

    test('includes entries up to 2x medium deviation (300)', () => {
      const imageA = createMockEntry(1, 1580);

      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1750), // Deviation: 250 (within 300), diff: 170 - MATCH
        createMockEntry(3, 1200), // Deviation: 300 (boundary), diff: 380 - too far ELO
      ];

      const pool = getCandidateBPool(entries, imageA, 'discovery');

      expect(pool).toContain(2); // Deviation 250 <= 300 and within ELO range
    });

    test('falls back to all entries if no uncertain entries available', () => {
      const imageA = createMockEntry(1, 1580);

      // All entries either too low deviation or too far ELO
      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1500), // Deviation: 0 (too low)
        createMockEntry(3, 1510), // Deviation: 10 (too low)
      ];

      const pool = getCandidateBPool(entries, imageA, 'discovery');

      // Should fall back to all entries
      expect(pool).toHaveLength(2);
    });
  });

  describe('getCandidateBPool - Optimization Phase (similar ELO selection)', () => {
    test('selects entries within 100 ELO for optimization', () => {
      // Entry with high deviation (optimization phase)
      const imageA = createMockEntry(1, 1700); // Deviation: 200 (optimization)

      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1720), // Diff: 20 - MATCH
        createMockEntry(3, 1650), // Diff: 50 - MATCH
        createMockEntry(4, 1800), // Diff: 100 - MATCH (boundary)
        createMockEntry(5, 1550), // Diff: 150 - too far
        createMockEntry(6, 1900), // Diff: 200 - too far
      ];

      const pool = getCandidateBPool(entries, imageA, 'optimization');

      expect(pool).toContain(2); // Within 100 ELO
      expect(pool).toContain(3); // Within 100 ELO
      expect(pool).toContain(4); // Exactly 100 ELO diff (boundary)
      expect(pool).toNotContain(5); // 150 > 100
      expect(pool).toNotContain(6); // 200 > 100
    });

    test('expands to 200 ELO range if no entries within 100', () => {
      const imageA = createMockEntry(1, 1700);

      // No entries within 100 ELO
      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1550), // Diff: 150 - within 200
        createMockEntry(3, 1850), // Diff: 150 - within 200
        createMockEntry(4, 1400), // Diff: 300 - too far
      ];

      const pool = getCandidateBPool(entries, imageA, 'optimization');

      expect(pool).toContain(2); // Within expanded 200 range
      expect(pool).toContain(3); // Within expanded 200 range
      expect(pool).toNotContain(4); // 300 > 200
    });

    test('falls back to all entries if no similar ELO available', () => {
      const imageA = createMockEntry(1, 1700);

      // All entries too far
      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1200), // Diff: 500
        createMockEntry(3, 2000), // Diff: 300
      ];

      const pool = getCandidateBPool(entries, imageA, 'optimization');

      // Should fall back to all entries
      expect(pool).toHaveLength(2);
    });
  });

  describe('getCandidateBPool - Image A exclusion', () => {
    test('always excludes Image A from candidate pool', () => {
      const imageA = createMockEntry(1, 1500);

      const entries: EntryForJudging[] = [
        imageA,
        createMockEntry(2, 1600),
        createMockEntry(3, 1400),
      ];

      // Test all phases
      const calibrationPool = getCandidateBPool(entries, imageA, 'calibration');
      const discoveryPool = getCandidateBPool(entries, imageA, 'discovery');
      const optimizationPool = getCandidateBPool(entries, imageA, 'optimization');

      expect(calibrationPool).toNotContain(1);
      expect(discoveryPool).toNotContain(1);
      expect(optimizationPool).toNotContain(1);
    });

    test('returns empty array when only Image A in entries', () => {
      const imageA = createMockEntry(1, 1500);
      const entries: EntryForJudging[] = [imageA];

      const pool = getCandidateBPool(entries, imageA, 'calibration');

      expect(pool).toBeEmpty();
    });
  });

  describe('createPairKey (for voted pairs tracking)', () => {
    test('creates canonical key with smaller ID first', () => {
      expect(createPairKey(1, 2)).toBe('1:2');
      expect(createPairKey(5, 10)).toBe('5:10');
      expect(createPairKey(100, 200)).toBe('100:200');
    });

    test('same key regardless of order (a:b == b:a)', () => {
      expect(createPairKey(1, 2)).toBe(createPairKey(2, 1));
      expect(createPairKey(5, 10)).toBe(createPairKey(10, 5));
      expect(createPairKey(100, 200)).toBe(createPairKey(200, 100));
    });

    test('handles same ID (edge case)', () => {
      expect(createPairKey(5, 5)).toBe('5:5');
    });
  });

  describe('Low-deviation entry prioritization', () => {
    test('entries with lower deviation should be prioritized for Image A selection', () => {
      // This tests the concept - actual prioritization happens in getJudgingPair
      // which sorts entries by deviation ascending before selecting Image A

      const entries = [
        createMockEntry(1, 1500), // Deviation: 0
        createMockEntry(2, 1520), // Deviation: 20
        createMockEntry(3, 1600), // Deviation: 100
        createMockEntry(4, 1700), // Deviation: 200
      ];

      // Sort by deviation (ascending) - simulates what getJudgingPair does
      const sortedByDeviation = [...entries].sort(
        (a, b) => getEloDeviation(a.score) - getEloDeviation(b.score)
      );

      // Entry with lowest deviation should be first
      expect(sortedByDeviation[0].id).toBe(1);
      expect(sortedByDeviation[1].id).toBe(2);
      expect(sortedByDeviation[2].id).toBe(3);
      expect(sortedByDeviation[3].id).toBe(4);

      // Verify deviations are ascending
      expect(getEloDeviation(sortedByDeviation[0].score)).toBe(0);
      expect(getEloDeviation(sortedByDeviation[1].score)).toBe(20);
      expect(getEloDeviation(sortedByDeviation[2].score)).toBe(100);
      expect(getEloDeviation(sortedByDeviation[3].score)).toBe(200);
    });

    test('entries close to 1500 (low deviation) get more voting attention', () => {
      // Conceptual test: new entries start at 1500, so they have 0 deviation
      // The algorithm prioritizes these to help them get calibrated faster

      const newEntry = createMockEntry(1, CRUCIBLE_DEFAULT_ELO);
      expect(getEloDeviation(newEntry.score)).toBe(0);
      expect(getVotingPhase(getEloDeviation(newEntry.score))).toBe('calibration');
    });
  });

  describe('Voted pairs exclusion (conceptual)', () => {
    test('createPairKey produces unique keys for unique pairs', () => {
      const pairs = new Set<string>();

      // Add several pair keys
      pairs.add(createPairKey(1, 2));
      pairs.add(createPairKey(3, 4));
      pairs.add(createPairKey(5, 6));

      expect(pairs.size).toBe(3);

      // Adding reverse pairs should not increase set size
      pairs.add(createPairKey(2, 1));
      pairs.add(createPairKey(4, 3));
      pairs.add(createPairKey(6, 5));

      expect(pairs.size).toBe(3); // Still 3 because pairs are canonical
    });

    test('voted pair lookup is O(1) with Set', () => {
      // Simulate Redis SISMEMBER behavior with JS Set
      const votedPairs = new Set(['1:2', '3:4', '5:6']);

      // Check if pair is voted
      const pairKey = createPairKey(1, 2);
      const isVoted = votedPairs.has(pairKey);

      expect(isVoted).toBe(true);

      // Check unvoted pair
      const unvotedKey = createPairKey(1, 3);
      expect(votedPairs.has(unvotedKey)).toBe(false);
    });
  });

  describe('Constants verification', () => {
    test('CRUCIBLE_DEFAULT_ELO is 1500', () => {
      expect(CRUCIBLE_DEFAULT_ELO).toBe(1500);
    });

    test('ELO_DEVIATION_LOW is 50 (calibration threshold)', () => {
      expect(ELO_DEVIATION_LOW).toBe(50);
    });

    test('ELO_DEVIATION_MED is 150 (discovery threshold)', () => {
      expect(ELO_DEVIATION_MED).toBe(150);
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
