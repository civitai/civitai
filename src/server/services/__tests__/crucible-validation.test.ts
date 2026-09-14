import { describe, expect, it } from 'vitest';
import {
  calculateCrucibleSetupCost,
  cancelCrucibleSchema,
  createCrucibleInputSchema,
  crucibleImageSchema,
  getCruciblesInfiniteSchema,
  getJudgingPairSchema,
  submitEntrySchema,
  submitVoteSchema,
} from '~/server/schema/crucible.schema';
import { CrucibleSort } from '~/server/common/enums';
import {
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
} from '~/shared/constants/crucible.constants';

const validCoverImage = {
  url: '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900',
  width: 512,
  height: 704,
};

const validCreateInput = {
  name: 'Test Crucible',
  description: 'A description',
  coverImage: validCoverImage,
  nsfwLevel: 1,
  entryFee: 100,
  entryLimit: 1,
  prizePositions: { '1': 50, '2': 30, '3': 20 },
  duration: 8,
};

describe('crucibleImageSchema', () => {
  it('accepts a Cloudflare id whose variant nibble is not RFC-4122 conformant', () => {
    // Real id from Image.url. `z.string().uuid()` rejects it under Zod 4 because the fourth
    // group starts with 7 rather than [89ab], and the user is told their upload failed.
    const result = crucibleImageSchema.safeParse({
      ...validCoverImage,
      url: '276019b4-2214-4bb8-73a8-5a20287ebd00',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a conformant id', () => {
    expect(crucibleImageSchema.safeParse(validCoverImage).success).toBe(true);
  });

  it.each([
    ['not a uuid at all', 'banana'],
    ['too few groups', '6a1c3f3d-29e5-49c1-816f'],
    ['a non-hex character', '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c9zz'],
    ['surrounding whitespace', ' 6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900 '],
    ['a full url rather than an id', 'https://example.com/image.png'],
    ['an empty string', ''],
  ])('still rejects %s', (_label, url) => {
    expect(crucibleImageSchema.safeParse({ ...validCoverImage, url }).success).toBe(false);
  });

  it('requires width and height', () => {
    expect(crucibleImageSchema.safeParse({ url: validCoverImage.url }).success).toBe(false);
  });
});

describe('createCrucibleInputSchema', () => {
  it('accepts a well-formed crucible', () => {
    expect(createCrucibleInputSchema.safeParse(validCreateInput).success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, name: '   ' }).success).toBe(
      false
    );
  });

  it('rejects a missing description', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, description: '' }).success
    ).toBe(false);
  });

  it('rejects a negative entry fee', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, entryFee: -1 }).success).toBe(
      false
    );
  });

  it('accepts an entry fee at the cap and rejects one above it', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, entryFee: CRUCIBLE_MAX_ENTRY_FEE })
        .success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryFee: CRUCIBLE_MAX_ENTRY_FEE + 1,
      }).success
    ).toBe(false);
  });

  it('requires an entry limit of at least one, capped at CRUCIBLE_MAX_ENTRIES', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, entryLimit: 0 }).success).toBe(
      false
    );
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryLimit: CRUCIBLE_MAX_ENTRIES,
      }).success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryLimit: CRUCIBLE_MAX_ENTRIES + 1,
      }).success
    ).toBe(false);
  });

  it('rejects prize percentages summing above 100', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 60, '2': 50 },
      }).success
    ).toBe(false);
  });

  it('accepts prize percentages summing to exactly 100, and below it', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 100 },
      }).success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 40, '2': 20 },
      }).success
    ).toBe(true);
  });

  it('defaults prizeCustomized to false', () => {
    const parsed = createCrucibleInputSchema.parse(validCreateInput);
    expect(parsed.prizeCustomized).toBe(false);
  });

  it('rejects a duration below one hour', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, duration: 0 }).success).toBe(
      false
    );
  });
});

describe('calculateCrucibleSetupCost', () => {
  it.each(Object.entries(CRUCIBLE_DURATION_COSTS))(
    'charges %s hours at its listed cost when prizes are not customized',
    (duration, cost) => {
      expect(calculateCrucibleSetupCost(Number(duration), false)).toBe(cost);
    }
  );

  it('adds the customization fee on top of the duration cost', () => {
    expect(calculateCrucibleSetupCost(24, true)).toBe(
      CRUCIBLE_DURATION_COSTS[24] + CRUCIBLE_PRIZE_CUSTOMIZATION_COST
    );
  });

  it('charges only the customization fee when the duration itself is free', () => {
    expect(CRUCIBLE_DURATION_COSTS[8]).toBe(0);
    expect(calculateCrucibleSetupCost(8, true)).toBe(CRUCIBLE_PRIZE_CUSTOMIZATION_COST);
  });

  it('treats an unlisted duration as free rather than NaN', () => {
    expect(calculateCrucibleSetupCost(9999, false)).toBe(0);
  });
});

describe('submitEntrySchema', () => {
  it('requires both ids as numbers', () => {
    expect(submitEntrySchema.safeParse({ crucibleId: 1, imageId: 2 }).success).toBe(true);
    expect(submitEntrySchema.safeParse({ crucibleId: '1', imageId: 2 }).success).toBe(false);
    expect(submitEntrySchema.safeParse({ crucibleId: 1 }).success).toBe(false);
  });
});

describe('submitVoteSchema', () => {
  it('requires the crucible and both entry ids', () => {
    expect(
      submitVoteSchema.safeParse({ crucibleId: 1, winnerEntryId: 2, loserEntryId: 3 }).success
    ).toBe(true);
    expect(submitVoteSchema.safeParse({ crucibleId: 1, winnerEntryId: 2 }).success).toBe(false);
  });
});

describe('getJudgingPairSchema', () => {
  it('allows the exclude list to be omitted', () => {
    expect(getJudgingPairSchema.safeParse({ crucibleId: 1 }).success).toBe(true);
  });

  it('caps the exclude list at 50 entries', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(getJudgingPairSchema.safeParse({ crucibleId: 1, excludeEntryIds: ids(50) }).success).toBe(
      true
    );
    expect(getJudgingPairSchema.safeParse({ crucibleId: 1, excludeEntryIds: ids(51) }).success).toBe(
      false
    );
  });
});

describe('cancelCrucibleSchema', () => {
  it('requires a numeric id', () => {
    expect(cancelCrucibleSchema.safeParse({ id: 1 }).success).toBe(true);
    expect(cancelCrucibleSchema.safeParse({ id: 'one' }).success).toBe(false);
  });
});

describe('getCruciblesInfiniteSchema', () => {
  it('defaults sort to PrizePool and limit to 20', () => {
    const parsed = getCruciblesInfiniteSchema.parse({});
    expect(parsed.sort).toBe(CrucibleSort.PrizePool);
    expect(parsed.limit).toBe(20);
  });

  it('coerces a string limit, since it arrives from a query string', () => {
    expect(getCruciblesInfiniteSchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects a limit above 200', () => {
    expect(getCruciblesInfiniteSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('rejects an unknown sort', () => {
    expect(getCruciblesInfiniteSchema.safeParse({ sort: 'Whatever' }).success).toBe(false);
  });
});
