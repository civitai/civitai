import { describe, expect, it } from 'vitest';
import {
  CRUCIBLE_EDITABLE_WHILE_ACTIVE,
  PRIZE_PLACE_COLORS,
  crucibleCreateDefaultValues,
  crucibleCreateDraftSchema,
  crucibleToFormValues,
  getCrucibleCostBreakdown,
  getCrucibleEditableFields,
  getCrucibleUpdateChanges,
  getMaxCrucibleSeed,
  getPlaceBuzz,
  getPrizePlaceColor,
  getPrizePlaceLimit,
  restrictContentLevelsToBuzzType,
  toCrucibleSubmitValues,
  type CrucibleEditSource,
} from '~/components/Crucible/crucible-create-form';
import { NsfwLevel } from '~/server/common/enums';
import { calculateCrucibleSetupCost } from '~/server/schema/crucible.schema';
import {
  CRUCIBLE_MAX_PRIZE_POSITIONS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  isCustomPrizeDistribution,
} from '~/shared/constants/crucible.constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  mergeRestoredValues,
  readStoredFormValue,
  serializeStoredFormValue,
} from '~/hooks/useFormStorage';

const HOUR = 60 * 60 * 1000;

// The same round trip useFormStorage makes: JSON in localStorage, merged over the fresh form.
function restore(draft: Record<string, unknown>) {
  const stored = readStoredFormValue(serializeStoredFormValue(draft));
  return crucibleCreateDraftSchema.safeParse(
    mergeRestoredValues({ current: { ...crucibleCreateDefaultValues }, stored: stored?.value })
  );
}

describe('crucible create draft restore', () => {
  it('fills in the late-entry defaults for a draft saved before they existed', () => {
    const { entryWarningPercent, entryCutoffPercent, ...older } = crucibleCreateDefaultValues;
    const result = restore({ ...older, name: 'Neon city', entryWarningPercent: 'x' });

    expect(result.success).toBe(true);
    expect([entryWarningPercent, entryCutoffPercent], 'the defaults').toEqual([20, 10]);
    expect(result.data).toMatchObject({
      name: 'Neon city',
      entryWarningPercent: 20,
      entryCutoffPercent: 10,
    });
  });

  it('restores a complete draft, reviving the start date and keeping the step', () => {
    const startAt = new Date(Date.now() + 24 * HOUR);
    const coverImage = {
      url: '4e7a1c2e-8f3b-4d5a-9c6e-2b1f0a9d8e7c',
      width: 1600,
      height: 900,
      hash: 'abc',
    };
    const heroImage = { url: '9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e', width: 2400, height: 800 };
    const result = restore({
      ...crucibleCreateDefaultValues,
      name: 'Neon city',
      description: 'Cyberpunk',
      startAt,
      maxTotalEntries: 50,
      allowedResources: [10, 20],
      coverImage,
      heroImage,
      step: 3,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: 'Neon city',
      description: 'Cyberpunk',
      maxTotalEntries: 50,
      allowedResources: [10, 20],
      coverImage,
      heroImage,
      step: 3,
    });
    expect(result.data?.startAt).toBeInstanceOf(Date);
    expect(result.data?.startAt?.getTime()).toBe(startAt.getTime());
  });

  it('still restores a draft saved mid-edit, dropping only the fields the form would reject', () => {
    const result = restore({
      ...crucibleCreateDefaultValues,
      name: '',
      description: 'kept',
      entryFee: 1,
      maxTotalEntries: 1,
      startAt: new Date(Date.now() - HOUR),
      heroImage: { url: 'not-an-upload', width: 10, height: 10 },
      step: 2,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: '',
      description: 'kept',
      entryFee: crucibleCreateDefaultValues.entryFee,
      maxTotalEntries: undefined,
      startAt: null,
      heroImage: null,
      step: 2,
    });
  });
});

describe('crucible create draft restore — Buzz type', () => {
  it('restores a draft saved while the form still had a Buzz type, without it', () => {
    const result = restore({ ...crucibleCreateDefaultValues, buzzType: 'green' });
    expect(result.success).toBe(true);
    expect(result.success && 'buzzType' in result.data).toBe(false);
  });
});

describe('getMaxCrucibleSeed', () => {
  it('caps the seed at the Buzz the creator holds', () => {
    expect(getMaxCrucibleSeed({ balance: 5_000 })).toBe(5_000);
  });

  it('never goes above the crucible seed limit, however much Buzz there is', () => {
    expect(getMaxCrucibleSeed({ balance: 50_000_000 })).toBe(CRUCIBLE_MAX_SEEDED_PRIZE_POOL);
  });

  it('counts the seed already paid when editing, since it is refunded before the new one is charged', () => {
    expect(getMaxCrucibleSeed({ balance: 500, paidSeed: 1_000 })).toBe(1_500);
  });

  it('allows no new Buzz from an empty or negative balance', () => {
    expect(getMaxCrucibleSeed({ balance: -20 })).toBe(0);
    expect(getMaxCrucibleSeed({ balance: 0, paidSeed: 300 })).toBe(300);
  });
});

describe('getPlaceBuzz', () => {
  const prizePositions = { '1': 50, '2': 30, '3': 20 };

  it('shows nothing when there is no seed and no entry cap', () => {
    expect(
      getPlaceBuzz({
        prizePositions,
        seededPrizePool: 0,
        entryFee: 100,
        maxTotalEntries: undefined,
      })
    ).toEqual({
      '1': { fromSeed: undefined, whenFull: undefined },
      '2': { fromSeed: undefined, whenFull: undefined },
      '3': { fromSeed: undefined, whenFull: undefined },
    });
  });

  it('splits the seed alone, and seed plus every capped entry fee for a full crucible', () => {
    expect(
      getPlaceBuzz({ prizePositions, seededPrizePool: 1000, entryFee: 100, maxTotalEntries: 10 })
    ).toEqual({
      '1': { fromSeed: 500, whenFull: 1000 },
      '2': { fromSeed: 300, whenFull: 600 },
      '3': { fromSeed: 200, whenFull: 400 },
    });
  });

  it('gives an unfillable place nothing when the cap is below the number of places', () => {
    expect(
      getPlaceBuzz({ prizePositions, seededPrizePool: 800, entryFee: 100, maxTotalEntries: 2 })
    ).toEqual({
      '1': { fromSeed: 500, whenFull: 625 },
      '2': { fromSeed: 300, whenFull: 375 },
      '3': { fromSeed: 0, whenFull: 0 },
    });
  });

  it('splits evenly, never NaN, while every filled place is at 0%', () => {
    const amounts = getPlaceBuzz({
      prizePositions: { '1': 0, '2': 0, '3': 100 },
      seededPrizePool: 1000,
      entryFee: 100,
      maxTotalEntries: 2,
    });

    expect(amounts['1']).toEqual({ fromSeed: 500, whenFull: 600 });
  });

  it('marks the full-crucible amount as a ceiling once entries can be free', () => {
    const args = { prizePositions, seededPrizePool: 1000, entryFee: 100, maxTotalEntries: 10 };

    expect(getPlaceBuzz({ ...args, freeEntriesPerUser: 1 })['1']).toEqual({
      fromSeed: 500,
      whenFull: 1000,
      whenFullIsCeiling: true,
    });
    expect(getPlaceBuzz(args)['1'].whenFullIsCeiling).toBeFalsy();
  });
});

describe('restrictContentLevelsToBuzzType', () => {
  const sfw = NsfwLevel.PG | NsfwLevel.PG13;

  it('leaves yellow crucibles and SFW-only green crucibles alone', () => {
    expect(restrictContentLevelsToBuzzType('yellow', sfw | NsfwLevel.X)).toBe(sfw | NsfwLevel.X);
    expect(restrictContentLevelsToBuzzType('green', sfw)).toBe(sfw);
  });

  it('strips the non-SFW levels from a green crucible, falling back to PG', () => {
    expect(restrictContentLevelsToBuzzType('green', NsfwLevel.PG13 | NsfwLevel.R)).toBe(
      NsfwLevel.PG13
    );
    expect(restrictContentLevelsToBuzzType('green', NsfwLevel.R | NsfwLevel.XXX)).toBe(
      NsfwLevel.PG
    );
  });
});

describe('prize places', () => {
  it('gives every place a color, never a Buzz currency color, rotating past the palette', () => {
    expect(new Set(PRIZE_PLACE_COLORS).size).toBe(PRIZE_PLACE_COLORS.length);
    for (const currencyColor of ['blue', 'green', 'yellow'])
      expect(PRIZE_PLACE_COLORS).not.toContain(currencyColor);
    expect(getPrizePlaceColor(PRIZE_PLACE_COLORS.length + 1)).toBe(getPrizePlaceColor(1));
  });

  it('caps the places at the total entry cap, and at the global maximum without one', () => {
    expect(getPrizePlaceLimit(2)).toBe(2);
    expect(getPrizePlaceLimit(undefined)).toBe(CRUCIBLE_MAX_PRIZE_POSITIONS);
    expect(getPrizePlaceLimit(0)).toBe(CRUCIBLE_MAX_PRIZE_POSITIONS);
    expect(getPrizePlaceLimit(CRUCIBLE_MAX_PRIZE_POSITIONS * 10)).toBe(
      CRUCIBLE_MAX_PRIZE_POSITIONS
    );
  });
});

describe('getCrucibleCostBreakdown', () => {
  it.each([
    [24, { '1': 50, '2': 30, '3': 20 }, []],
    [168, { '1': 100 }, [5]],
    [72, { '1': 60, '2': 40 }, []],
  ])(
    'totals the setup cost the server charges plus the seed (%i h)',
    (duration, prizePositions, allowedResources) => {
      const { total } = getCrucibleCostBreakdown({
        duration,
        prizePositions,
        allowedResources,
        seededPrizePool: 250,
      });
      expect(total).toBe(
        calculateCrucibleSetupCost(
          duration,
          isCustomPrizeDistribution(prizePositions),
          allowedResources.length > 0
        ) + 250
      );
    }
  );
});

describe('toCrucibleSubmitValues', () => {
  it.each(['', '   '])('omits a blank description (%j)', (description) => {
    expect(
      toCrucibleSubmitValues({ ...crucibleCreateDefaultValues, description }).description
    ).toBeUndefined();
  });

  it('trims the description', () => {
    expect(
      toCrucibleSubmitValues({ ...crucibleCreateDefaultValues, description: ' Neon ' }).description
    ).toBe('Neon');
  });
});

describe('crucible edit', () => {
  const cover = { url: '4e7a1c2e-8f3b-4d5a-9c6e-2b1f0a9d8e7c', width: 1600, height: 900 };
  const crucible: CrucibleEditSource = {
    name: 'Neon city',
    description: 'Cyberpunk',
    duration: 72 * 60,
    startAt: new Date(Date.now() + 24 * HOUR),
    nsfwLevel: NsfwLevel.PG,
    contentType: MediaType.video,
    entryFee: 50,
    entryLimit: 2,
    freeEntriesPerUser: 1,
    maxTotalEntries: 40,
    entryWarningPercent: 30,
    entryCutoffPercent: 5,
    minViewSeconds: 6,
    maxClipSeconds: null,
    seededPrizePool: 1000,
    prizePositions: { '1': 70, '2': 30, '3': 0 },
    allowedResources: [10, 20],
    allowedBaseModels: ['MiniMax H3'],
    image: cover,
    heroImage: { url: '9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e', width: null, height: null },
  };
  const initial = crucibleToFormValues(crucible);
  const allFields = getCrucibleEditableFields({ canEditAll: true, canEditContentLevels: true });

  it('reads the stored minutes as hours', () => {
    expect(initial.duration).toBe(72);
  });

  it('carries the free entries into the form and sends them back only when changed', () => {
    expect(initial.freeEntriesPerUser).toBe(1);
    expect(
      getCrucibleUpdateChanges({
        initial,
        values: { ...initial, freeEntriesPerUser: 2 },
        editableFields: allFields,
      })
    ).toEqual({ freeEntriesPerUser: 2 });
  });

  it('carries the late-entry shares into the form and sends them back only when changed', () => {
    expect([initial.entryWarningPercent, initial.entryCutoffPercent]).toEqual([30, 5]);
    expect(
      getCrucibleUpdateChanges({
        initial,
        values: { ...initial, entryCutoffPercent: 0 },
        editableFields: allFields,
      })
    ).toEqual({ entryCutoffPercent: 0 });
  });

  it('does not let the late-entry shares change once the crucible has started', () => {
    const whileActive = getCrucibleEditableFields({
      canEditAll: false,
      canEditContentLevels: false,
    });
    expect(
      getCrucibleUpdateChanges({
        initial,
        values: { ...initial, entryWarningPercent: 40, entryCutoffPercent: 20 },
        editableFields: whileActive,
      })
    ).toEqual({});
  });

  it('sends cleared base models as an empty list, which the server reads as no restriction', () => {
    expect(initial.allowedBaseModels).toEqual(['MiniMax H3']);
    expect(
      getCrucibleUpdateChanges({
        initial,
        values: { ...initial, allowedBaseModels: [] },
        editableFields: allFields,
      })
    ).toEqual({ allowedBaseModels: [] });
  });

  it('keeps a 0% place, so a stored custom split does not read as the default', () => {
    expect(initial.prizePositions).toEqual({ '1': 70, '2': 30, '3': 0 });
  });

  it('sends nothing for an untouched crucible', () => {
    expect(
      getCrucibleUpdateChanges({ initial, values: { ...initial }, editableFields: allFields })
    ).toEqual({});
  });

  it('sends only the fields that changed, and clears emptied ones explicitly', () => {
    const changes = getCrucibleUpdateChanges({
      initial,
      values: {
        ...initial,
        name: '  Neon city at night ',
        startAt: null,
        maxTotalEntries: undefined,
        minViewSeconds: 0,
        allowedResources: [],
        heroImage: null,
        coverImage: { ...cover, hash: 'abc' },
      },
      editableFields: allFields,
    });
    expect(changes).toEqual({
      name: 'Neon city at night',
      startAt: null,
      maxTotalEntries: null,
      minViewSeconds: null,
      allowedResources: [],
      heroImage: null,
    });
  });

  it('never sends a field the viewer cannot change', () => {
    const editableFields = getCrucibleEditableFields({
      canEditAll: false,
      canEditContentLevels: false,
    });
    expect(editableFields).toEqual(CRUCIBLE_EDITABLE_WHILE_ACTIVE);

    const changes = getCrucibleUpdateChanges({
      initial,
      values: { ...initial, description: '', entryFee: 500, nsfwLevel: NsfwLevel.PG13 },
      editableFields,
    });
    expect(changes).toEqual({ description: null });
  });

  it("sends content levels only when they're editable", () => {
    const edit = (canEditContentLevels: boolean) =>
      getCrucibleUpdateChanges({
        initial,
        values: { ...initial, nsfwLevel: NsfwLevel.PG13 },
        editableFields: getCrucibleEditableFields({ canEditAll: false, canEditContentLevels }),
      });
    expect(edit(true)).toEqual({ nsfwLevel: NsfwLevel.PG13 });
    expect(edit(false)).toEqual({});
  });

  it('clears the video rules when a video crucible becomes an image crucible', () => {
    const changes = getCrucibleUpdateChanges({
      initial,
      values: { ...initial, contentType: MediaType.image },
      editableFields: allFields,
    });
    expect(changes).toEqual({ contentType: MediaType.image, minViewSeconds: null });
  });
});
