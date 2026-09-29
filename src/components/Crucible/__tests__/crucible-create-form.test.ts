import { describe, expect, it } from 'vitest';
import {
  crucibleCreateDefaultValues,
  crucibleCreateDraftSchema,
  getPlaceBuzz,
} from '~/components/Crucible/crucible-create-form';
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
  it('restores a complete draft, reviving the start date and keeping the step', () => {
    const startAt = new Date(Date.now() + 24 * HOUR);
    const coverImage = {
      url: '4e7a1c2e-8f3b-4d5a-9c6e-2b1f0a9d8e7c',
      width: 1600,
      height: 900,
      hash: 'abc',
    };
    const result = restore({
      ...crucibleCreateDefaultValues,
      name: 'Neon city',
      description: 'Cyberpunk',
      startAt,
      maxTotalEntries: 50,
      allowedResources: [10, 20],
      coverImage,
      step: 3,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: 'Neon city',
      description: 'Cyberpunk',
      maxTotalEntries: 50,
      allowedResources: [10, 20],
      coverImage,
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
      step: 2,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: '',
      description: 'kept',
      entryFee: crucibleCreateDefaultValues.entryFee,
      maxTotalEntries: undefined,
      startAt: null,
      step: 2,
    });
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
});
