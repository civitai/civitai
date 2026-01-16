/**
 * Unit tests for crucible-elo.service.ts
 *
 * These tests verify the ELO calculation logic using pure function tests.
 * Run with: npx tsx src/server/services/__tests__/crucible-elo.service.test.ts
 *
 * Note: These tests inline the pure function implementations to avoid importing
 * the service file which has Redis dependencies requiring environment variables.
 * The implementations MUST match those in crucible-elo.service.ts exactly.
 *
 * @file crucible-elo.service.test.ts
 */

// Wrap in IIFE to scope variables (avoids conflicts with other test files during typecheck)
(function runEloTests() {
  // ============================================================
  // CONSTANTS (must match crucible-elo.service.ts)
  // ============================================================
  const K_FACTOR_PROVISIONAL = 64;
  const K_FACTOR_ESTABLISHED = 32;
  const PROVISIONAL_VOTE_THRESHOLD = 10;
  const CRUCIBLE_DEFAULT_ELO = 1500;

// ============================================================
// PURE FUNCTIONS UNDER TEST (must match crucible-elo.service.ts)
// ============================================================

/**
 * Calculate the ELO rating change after a match
 * Based on the standard ELO formula:
 * - Expected score: Ea = 1 / (1 + 10^((Rb - Ra) / 400))
 * - New rating: Ra' = Ra + K * (Sa - Ea)
 */
const calculateEloChange = (
  winnerElo: number,
  loserElo: number,
  kFactor: number = K_FACTOR_ESTABLISHED
): [number, number] => {
  // Calculate expected scores using the ELO formula
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
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
 */
const getKFactor = (voteCount: number): number => {
  return voteCount < PROVISIONAL_VOTE_THRESHOLD ? K_FACTOR_PROVISIONAL : K_FACTOR_ESTABLISHED;
};

// Simple test utilities
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
    toBeCloseTo(expected: number, tolerance = 1) {
      if (typeof actual !== 'number') throw new Error(`Expected a number but got ${typeof actual}`);
      if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`Expected ${expected} (+/- ${tolerance}) but got ${actual}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (typeof actual !== 'number') throw new Error(`Expected a number but got ${typeof actual}`);
      if (actual <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeLessThan(expected: number) {
      if (typeof actual !== 'number') throw new Error(`Expected a number but got ${typeof actual}`);
      if (actual >= expected) {
        throw new Error(`Expected ${actual} to be less than ${expected}`);
      }
    },
    toBeSymmetric() {
      // For ELO changes: winner gain should equal loser loss (magnitude)
      const arr = actual as unknown as [number, number];
      if (!Array.isArray(arr) || arr.length !== 2) {
        throw new Error(`Expected array of [winnerChange, loserChange]`);
      }
      // Due to rounding, they might differ by 1
      const sum = arr[0] + arr[1];
      if (Math.abs(sum) > 1) {
        throw new Error(
          `Expected symmetric changes (sum ~= 0), but got winnerChange=${arr[0]}, loserChange=${arr[1]}, sum=${sum}`
        );
      }
    },
  };
}

// ============================================================
// TEST SUITE
// ============================================================

describe('calculateEloChange', () => {
  test('equal ratings (1500 vs 1500) should give moderate change', () => {
    // With equal ratings, expected score is 0.5 for both
    // Winner: K * (1 - 0.5) = K * 0.5 = 16 (with K=32)
    // Loser: K * (0 - 0.5) = K * -0.5 = -16 (with K=32)
    const [winnerChange, loserChange] = calculateEloChange(1500, 1500, 32);

    expect(winnerChange).toBe(16); // Winner gains 16
    expect(loserChange).toBe(-16); // Loser loses 16
  });

  test('equal ratings uses default K-factor of 32', () => {
    // Without specifying K-factor, should use default 32
    const [winnerChange, loserChange] = calculateEloChange(1500, 1500);

    expect(winnerChange).toBe(16);
    expect(loserChange).toBe(-16);
  });

  test('large rating difference (1800 vs 1200) - underdog wins', () => {
    // If 1200 beats 1800, 1200 is the winner (upset)
    // Expected score for winner (1200): 1 / (1 + 10^((1800-1200)/400)) = 1 / (1 + 10^1.5) ~ 0.031
    // Winner gains: 32 * (1 - 0.031) ~ 31
    // Loser loses: 32 * (0 - 0.969) ~ -31
    const [winnerChange, loserChange] = calculateEloChange(1200, 1800, 32);

    expect(winnerChange).toBeGreaterThan(25); // Large gain for upset
    expect(loserChange).toBeLessThan(-25); // Large loss for favorite
    expect([winnerChange, loserChange]).toBeSymmetric();
  });

  test('large rating difference (1800 vs 1200) - favorite wins', () => {
    // If 1800 beats 1200, expected outcome
    // Expected score for winner (1800): 1 / (1 + 10^((1200-1800)/400)) = 1 / (1 + 10^-1.5) ~ 0.969
    // Winner gains: 32 * (1 - 0.969) ~ 1
    // Loser loses: 32 * (0 - 0.031) ~ -1
    const [winnerChange, loserChange] = calculateEloChange(1800, 1200, 32);

    expect(winnerChange).toBeLessThan(5); // Small gain (expected outcome)
    expect(loserChange).toBeGreaterThan(-5); // Small loss (expected outcome)
    expect([winnerChange, loserChange]).toBeSymmetric();
  });

  test('returns symmetric changes (winner gain approximately equals loser loss)', () => {
    // Test multiple scenarios for symmetry
    const scenarios: Array<[number, number]> = [
      [1500, 1500],
      [1600, 1400],
      [1200, 1800],
      [1300, 1700],
      [CRUCIBLE_DEFAULT_ELO, CRUCIBLE_DEFAULT_ELO],
    ];

    for (const [winnerElo, loserElo] of scenarios) {
      const [winnerChange, loserChange] = calculateEloChange(winnerElo, loserElo, 32);
      expect([winnerChange, loserChange]).toBeSymmetric();
    }
  });

  test('changes scale with K-factor', () => {
    const [winnerChange32, loserChange32] = calculateEloChange(1500, 1500, 32);
    const [winnerChange64, loserChange64] = calculateEloChange(1500, 1500, 64);

    // K=64 should give double the change of K=32
    expect(winnerChange64).toBe(winnerChange32 * 2);
    expect(loserChange64).toBe(loserChange32 * 2);
  });

  test('winner always gains rating (positive change)', () => {
    const [winnerChange] = calculateEloChange(1200, 1800, 32);
    expect(winnerChange).toBeGreaterThan(0);
  });

  test('loser always loses rating (negative change)', () => {
    const [, loserChange] = calculateEloChange(1200, 1800, 32);
    expect(loserChange).toBeLessThan(0);
  });
});

describe('getKFactor', () => {
  test('returns 64 for provisional (< 10 votes)', () => {
    expect(getKFactor(0)).toBe(K_FACTOR_PROVISIONAL);
    expect(getKFactor(5)).toBe(K_FACTOR_PROVISIONAL);
    expect(getKFactor(9)).toBe(K_FACTOR_PROVISIONAL);
  });

  test('returns 32 for established (>= 10 votes)', () => {
    expect(getKFactor(10)).toBe(K_FACTOR_ESTABLISHED);
    expect(getKFactor(15)).toBe(K_FACTOR_ESTABLISHED);
    expect(getKFactor(100)).toBe(K_FACTOR_ESTABLISHED);
  });

  test('threshold boundary: 9 is provisional, 10 is established', () => {
    expect(getKFactor(PROVISIONAL_VOTE_THRESHOLD - 1)).toBe(K_FACTOR_PROVISIONAL);
    expect(getKFactor(PROVISIONAL_VOTE_THRESHOLD)).toBe(K_FACTOR_ESTABLISHED);
  });

  test('K_FACTOR_PROVISIONAL is 64', () => {
    expect(K_FACTOR_PROVISIONAL).toBe(64);
  });

  test('K_FACTOR_ESTABLISHED is 32', () => {
    expect(K_FACTOR_ESTABLISHED).toBe(32);
  });
});

describe('Constants', () => {
  test('CRUCIBLE_DEFAULT_ELO is 1500', () => {
    expect(CRUCIBLE_DEFAULT_ELO).toBe(1500);
  });

  test('PROVISIONAL_VOTE_THRESHOLD is 10', () => {
    expect(PROVISIONAL_VOTE_THRESHOLD).toBe(10);
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
