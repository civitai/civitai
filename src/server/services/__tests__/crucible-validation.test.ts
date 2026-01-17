/**
 * Unit tests for crucible entry validation logic
 *
 * Tests verify the validation logic used in submitEntry function:
 * - NSFW level validation (entry NSFW must intersect with crucible NSFW)
 * - Entry limit validation (user can't exceed limit)
 * - Duplicate image validation (same image can't be submitted twice)
 * - Crucible status validation (can only submit to active crucibles)
 *
 * Run with: npx tsx src/server/services/__tests__/crucible-validation.test.ts
 *
 * Note: These tests inline the pure function implementations to avoid importing
 * the service file which has Redis/DB dependencies requiring environment variables.
 *
 * @file crucible-validation.test.ts
 */

// Wrap in IIFE to scope variables (avoids conflicts with other test files during typecheck)
(function runValidationTests() {
  // ============================================================
  // CONSTANTS (for test data)
  // ============================================================
  const CrucibleStatus = {
    Pending: 'Pending',
    Active: 'Active',
    Completed: 'Completed',
    Cancelled: 'Cancelled',
  } as const;

  // NSFW level flags (bitwise)
  // These are typical NSFW level flags used in the codebase
  const NsfwLevel = {
    None: 1,      // SFW content
    Soft: 2,      // Slightly suggestive
    Mature: 4,    // Mature content
    X: 8,         // Adult content
    Blocked: 16,  // Blocked content
  } as const;

  // ============================================================
  // PURE FUNCTIONS UNDER TEST (must match shared/utils/flags.ts)
  // ============================================================

  /**
   * Flags utility - intersection check
   * From src/shared/utils/flags.ts
   */
  const FlagsIntersects = (instance1: number, instance2: number): boolean => {
    return (instance1 & instance2) !== 0;
  };

  // ============================================================
  // VALIDATION LOGIC (extracted from crucible.service.ts submitEntry)
  // ============================================================

  type CrucibleData = {
    id: number;
    status: (typeof CrucibleStatus)[keyof typeof CrucibleStatus];
    nsfwLevel: number;
    entryLimit: number;
    maxTotalEntries: number | null;
    endAt: Date | null;
    totalEntries: number;
  };

  type ImageData = {
    id: number;
    userId: number;
    nsfwLevel: number;
  };

  type ValidationResult = {
    valid: boolean;
    error?: string;
  };

  /**
   * Validate NSFW level compatibility
   * Image NSFW level must intersect with crucible's allowed NSFW levels
   */
  function validateNsfwLevel(imageNsfwLevel: number, crucibleNsfwLevel: number): ValidationResult {
    if (!FlagsIntersects(imageNsfwLevel, crucibleNsfwLevel)) {
      return {
        valid: false,
        error: 'This image does not meet the content level requirements for this crucible',
      };
    }
    return { valid: true };
  }

  /**
   * Validate user entry limit
   * User cannot exceed the crucible's entry limit
   */
  function validateEntryLimit(userEntryCount: number, entryLimit: number): ValidationResult {
    if (userEntryCount >= entryLimit) {
      return {
        valid: false,
        error: `You have reached the maximum of ${entryLimit} ${entryLimit === 1 ? 'entry' : 'entries'} for this crucible`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate no duplicate image
   * Same image cannot be submitted to the same crucible twice
   */
  function validateNoDuplicateImage(existingImageIds: number[], newImageId: number): ValidationResult {
    if (existingImageIds.includes(newImageId)) {
      return {
        valid: false,
        error: 'This image has already been submitted to this crucible',
      };
    }
    return { valid: true };
  }

  /**
   * Validate crucible status
   * Can only submit to active crucibles that haven't ended
   */
  function validateCrucibleStatus(
    status: (typeof CrucibleStatus)[keyof typeof CrucibleStatus],
    endAt: Date | null,
    now: Date = new Date()
  ): ValidationResult {
    if (status !== CrucibleStatus.Active) {
      return {
        valid: false,
        error: 'This crucible is not accepting entries',
      };
    }

    if (endAt && now > endAt) {
      return {
        valid: false,
        error: 'This crucible has ended',
      };
    }

    return { valid: true };
  }

  /**
   * Validate max total entries limit
   * Crucible cannot exceed its maximum total entries
   */
  function validateMaxTotalEntries(
    currentEntryCount: number,
    maxTotalEntries: number | null
  ): ValidationResult {
    if (maxTotalEntries && currentEntryCount >= maxTotalEntries) {
      return {
        valid: false,
        error: 'This crucible has reached its maximum number of entries',
      };
    }
    return { valid: true };
  }

  /**
   * Validate image ownership
   * User can only submit their own images
   */
  function validateImageOwnership(imageUserId: number, submittingUserId: number): ValidationResult {
    if (imageUserId !== submittingUserId) {
      return {
        valid: false,
        error: 'You can only submit your own images',
      };
    }
    return { valid: true };
  }

  // ============================================================
  // SIMPLE TEST UTILITIES
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
          throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
        }
      },
      toBeTrue() {
        if (actual !== true) {
          throw new Error(`Expected true but got ${actual}`);
        }
      },
      toBeFalse() {
        if (actual !== false) {
          throw new Error(`Expected false but got ${actual}`);
        }
      },
      toContain(substring: string) {
        if (typeof actual !== 'string' || !actual.includes(substring)) {
          throw new Error(`Expected "${actual}" to contain "${substring}"`);
        }
      },
      toBeUndefined() {
        if (actual !== undefined) {
          throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
        }
      },
    };
  }

  // ============================================================
  // TEST SUITE: NSFW Level Validation
  // ============================================================

  describe('validateNsfwLevel', () => {
    test('allows image with matching NSFW level', () => {
      // Crucible allows SFW (1), image is SFW (1)
      const result = validateNsfwLevel(NsfwLevel.None, NsfwLevel.None);
      expect(result.valid).toBeTrue();
      expect(result.error).toBeUndefined();
    });

    test('allows image when NSFW levels intersect (image level is subset)', () => {
      // Crucible allows SFW + Soft (1 | 2 = 3), image is SFW (1)
      const crucibleLevel = NsfwLevel.None | NsfwLevel.Soft; // 3
      const result = validateNsfwLevel(NsfwLevel.None, crucibleLevel);
      expect(result.valid).toBeTrue();
    });

    test('allows image when NSFW levels intersect (partial overlap)', () => {
      // Crucible allows Soft + Mature (2 | 4 = 6), image is Soft (2)
      const crucibleLevel = NsfwLevel.Soft | NsfwLevel.Mature; // 6
      const result = validateNsfwLevel(NsfwLevel.Soft, crucibleLevel);
      expect(result.valid).toBeTrue();
    });

    test('rejects image when NSFW levels do not intersect', () => {
      // Crucible only allows SFW (1), image is Mature (4)
      const result = validateNsfwLevel(NsfwLevel.Mature, NsfwLevel.None);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('content level requirements');
    });

    test('rejects SFW image in NSFW-only crucible', () => {
      // Crucible only allows Mature + X (4 | 8 = 12), image is SFW (1)
      const crucibleLevel = NsfwLevel.Mature | NsfwLevel.X; // 12
      const result = validateNsfwLevel(NsfwLevel.None, crucibleLevel);
      expect(result.valid).toBeFalse();
    });

    test('rejects NSFW image in SFW-only crucible', () => {
      // Crucible only allows SFW (1), image is X (8)
      const result = validateNsfwLevel(NsfwLevel.X, NsfwLevel.None);
      expect(result.valid).toBeFalse();
    });

    test('handles multi-flag image with partial crucible match', () => {
      // Image has multiple flags (unlikely but possible): SFW + Soft (3)
      // Crucible allows SFW (1) - this should intersect
      const imageLevel = NsfwLevel.None | NsfwLevel.Soft; // 3
      const result = validateNsfwLevel(imageLevel, NsfwLevel.None);
      expect(result.valid).toBeTrue();
    });

    test('handles all NSFW levels allowed in crucible', () => {
      // Crucible allows all levels
      const crucibleLevel = NsfwLevel.None | NsfwLevel.Soft | NsfwLevel.Mature | NsfwLevel.X; // 15
      const result = validateNsfwLevel(NsfwLevel.X, crucibleLevel);
      expect(result.valid).toBeTrue();
    });
  });

  // ============================================================
  // TEST SUITE: Entry Limit Validation
  // ============================================================

  describe('validateEntryLimit', () => {
    test('allows entry when user has no entries yet', () => {
      const result = validateEntryLimit(0, 3);
      expect(result.valid).toBeTrue();
    });

    test('allows entry when user has less than limit', () => {
      const result = validateEntryLimit(2, 3);
      expect(result.valid).toBeTrue();
    });

    test('rejects entry when user has reached limit', () => {
      const result = validateEntryLimit(3, 3);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('maximum of 3 entries');
    });

    test('rejects entry when user has exceeded limit', () => {
      const result = validateEntryLimit(5, 3);
      expect(result.valid).toBeFalse();
    });

    test('handles single entry limit with correct grammar', () => {
      const result = validateEntryLimit(1, 1);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('maximum of 1 entry');
      // Should use singular "entry" not "entries"
    });

    test('handles plural entry limit with correct grammar', () => {
      const result = validateEntryLimit(2, 2);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('maximum of 2 entries');
    });

    test('allows first entry with single entry limit', () => {
      const result = validateEntryLimit(0, 1);
      expect(result.valid).toBeTrue();
    });
  });

  // ============================================================
  // TEST SUITE: Duplicate Image Validation
  // ============================================================

  describe('validateNoDuplicateImage', () => {
    test('allows image not in existing list', () => {
      const existingIds = [1, 2, 3];
      const result = validateNoDuplicateImage(existingIds, 4);
      expect(result.valid).toBeTrue();
    });

    test('rejects image already submitted', () => {
      const existingIds = [1, 2, 3];
      const result = validateNoDuplicateImage(existingIds, 2);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('already been submitted');
    });

    test('allows first image (empty existing list)', () => {
      const result = validateNoDuplicateImage([], 1);
      expect(result.valid).toBeTrue();
    });

    test('detects duplicate at start of list', () => {
      const existingIds = [100, 200, 300];
      const result = validateNoDuplicateImage(existingIds, 100);
      expect(result.valid).toBeFalse();
    });

    test('detects duplicate at end of list', () => {
      const existingIds = [100, 200, 300];
      const result = validateNoDuplicateImage(existingIds, 300);
      expect(result.valid).toBeFalse();
    });
  });

  // ============================================================
  // TEST SUITE: Crucible Status Validation
  // ============================================================

  describe('validateCrucibleStatus', () => {
    test('allows submission to active crucible', () => {
      const result = validateCrucibleStatus(CrucibleStatus.Active, null);
      expect(result.valid).toBeTrue();
    });

    test('rejects submission to pending crucible', () => {
      const result = validateCrucibleStatus(CrucibleStatus.Pending, null);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('not accepting entries');
    });

    test('rejects submission to completed crucible', () => {
      const result = validateCrucibleStatus(CrucibleStatus.Completed, null);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('not accepting entries');
    });

    test('rejects submission to cancelled crucible', () => {
      const result = validateCrucibleStatus(CrucibleStatus.Cancelled, null);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('not accepting entries');
    });

    test('allows submission to active crucible before end date', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const endAt = new Date('2024-01-20T12:00:00Z');
      const result = validateCrucibleStatus(CrucibleStatus.Active, endAt, now);
      expect(result.valid).toBeTrue();
    });

    test('rejects submission to active crucible after end date', () => {
      const now = new Date('2024-01-25T12:00:00Z');
      const endAt = new Date('2024-01-20T12:00:00Z');
      const result = validateCrucibleStatus(CrucibleStatus.Active, endAt, now);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('crucible has ended');
    });

    test('allows submission exactly at end time (boundary: now === endAt)', () => {
      // When now === endAt, now > endAt is false, so submission is allowed
      const endAt = new Date('2024-01-20T12:00:00.000Z');
      const now = new Date('2024-01-20T12:00:00.000Z');
      const result = validateCrucibleStatus(CrucibleStatus.Active, endAt, now);
      expect(result.valid).toBeTrue();
    });

    test('rejects submission 1ms after end time', () => {
      const endAt = new Date('2024-01-20T12:00:00.000Z');
      const now = new Date('2024-01-20T12:00:00.001Z');
      const result = validateCrucibleStatus(CrucibleStatus.Active, endAt, now);
      expect(result.valid).toBeFalse();
    });

    test('allows submission to crucible with no end date', () => {
      const result = validateCrucibleStatus(CrucibleStatus.Active, null);
      expect(result.valid).toBeTrue();
    });
  });

  // ============================================================
  // TEST SUITE: Max Total Entries Validation
  // ============================================================

  describe('validateMaxTotalEntries', () => {
    test('allows entry when no max limit set', () => {
      const result = validateMaxTotalEntries(100, null);
      expect(result.valid).toBeTrue();
    });

    test('allows entry when below max limit', () => {
      const result = validateMaxTotalEntries(49, 50);
      expect(result.valid).toBeTrue();
    });

    test('rejects entry when at max limit', () => {
      const result = validateMaxTotalEntries(50, 50);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('maximum number of entries');
    });

    test('rejects entry when above max limit', () => {
      const result = validateMaxTotalEntries(51, 50);
      expect(result.valid).toBeFalse();
    });

    test('allows first entry', () => {
      const result = validateMaxTotalEntries(0, 50);
      expect(result.valid).toBeTrue();
    });

    test('handles max limit of 1', () => {
      expect(validateMaxTotalEntries(0, 1).valid).toBeTrue();
      expect(validateMaxTotalEntries(1, 1).valid).toBeFalse();
    });
  });

  // ============================================================
  // TEST SUITE: Image Ownership Validation
  // ============================================================

  describe('validateImageOwnership', () => {
    test('allows submission of own image', () => {
      const result = validateImageOwnership(123, 123);
      expect(result.valid).toBeTrue();
    });

    test('rejects submission of another user\'s image', () => {
      const result = validateImageOwnership(456, 123);
      expect(result.valid).toBeFalse();
      expect(result.error!).toContain('only submit your own images');
    });
  });

  // ============================================================
  // TEST SUITE: Flags Utility (intersects)
  // ============================================================

  describe('FlagsIntersects', () => {
    test('returns true when values are equal', () => {
      expect(FlagsIntersects(1, 1)).toBeTrue();
    });

    test('returns true when there is bitwise overlap', () => {
      // 3 = 0011, 2 = 0010 -> intersection is 0010 (2) -> truthy
      expect(FlagsIntersects(3, 2)).toBeTrue();
    });

    test('returns false when no bitwise overlap', () => {
      // 1 = 0001, 2 = 0010 -> intersection is 0000 (0) -> falsy
      expect(FlagsIntersects(1, 2)).toBeFalse();
    });

    test('returns false when one value is 0', () => {
      expect(FlagsIntersects(0, 5)).toBeFalse();
      expect(FlagsIntersects(5, 0)).toBeFalse();
    });

    test('handles larger bitwise values', () => {
      // 15 = 1111, 8 = 1000 -> intersection is 1000 (8) -> truthy
      expect(FlagsIntersects(15, 8)).toBeTrue();
      // 7 = 0111, 8 = 1000 -> intersection is 0000 (0) -> falsy
      expect(FlagsIntersects(7, 8)).toBeFalse();
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
