import { describe, it, expect } from 'vitest';
import type { ModelVersionSaleWindow } from '@civitai/buzz';
import {
  budgetMonthOf,
  maxSaleDays,
  resolveSaleDraft,
  resolveSaleEligibility,
  maxSaleLeadDays,
  minCreatorScoreForSale,
  parseSalePreview,
  resolveSaleUndercut,
  saleLengthInDays,
  shortenBounds,
} from '../sales';

const MAX_SALE_LEAD_DAYS = maxSaleLeadDays();
const MIN_CREATOR_SCORE_FOR_SALE = minCreatorScoreForSale();

const NOW = new Date('2026-03-10T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const base = {
  selectedCount: 5,
  eligibleCount: 5,
  earlyAccessCount: 0,
  unpricedCount: 0,
  creatorScore: 25_000,
  tier: 'bronze',
  daysUsedInMonth: 0,
  draftDays: 3,
  amount: 20,
  type: 'Percent' as const,
  minCoveredPrice: 500,
  startsAt: days(1),
  now: NOW,
  resolving: false,
};

describe('maxSaleDays', () => {
  it('gives each tier its allowance, with founder matching bronze', () => {
    expect(maxSaleDays('free')).toBe(3);
    expect(maxSaleDays('bronze')).toBe(7);
    expect(maxSaleDays('silver')).toBe(14);
    expect(maxSaleDays('gold')).toBe(30);
    expect(maxSaleDays('founder')).toBe(maxSaleDays('bronze'));
  });

  it('falls back to FREE for an unknown or lapsed tier, never to zero', () => {
    // A lapse must not take the allowance to 0 — same rule as maxPermanentAccessModels.
    expect(maxSaleDays(null)).toBe(3);
    expect(maxSaleDays(undefined)).toBe(3);
    expect(maxSaleDays('platinum')).toBe(3);
  });
});

describe('saleLengthInDays', () => {
  it('rounds a partial day up', () => {
    expect(saleLengthInDays(NOW, new Date(NOW.getTime() + 36 * 60 * 60 * 1000))).toBe(2);
  });

  it('charges a full day for a window shorter than one, so short sales cannot be free', () => {
    expect(saleLengthInDays(NOW, new Date(NOW.getTime() + 23 * 60 * 60 * 1000))).toBe(1);
  });

  it('counts a whole window exactly', () => {
    expect(saleLengthInDays(NOW, days(7))).toBe(7);
  });

  it('costs nothing for an empty or inverted window', () => {
    expect(saleLengthInDays(NOW, NOW)).toBe(0);
    expect(saleLengthInDays(days(2), NOW)).toBe(0);
  });
});

describe('budgetMonthOf', () => {
  it('charges the month the sale STARTS in, so a crossing window costs one month', () => {
    expect(budgetMonthOf(new Date('2026-03-28T00:00:00Z')).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z'
    );
    expect(budgetMonthOf(new Date('2026-04-02T00:00:00Z')).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z'
    );
  });

  it('resolves in UTC, so every caller charges the same month', () => {
    // 23:30 on Mar 31 in UTC-6 is Apr 1 UTC. The budget follows UTC deliberately; a local-time answer
    // would let the same sale land in different months for the creator and the server.
    expect(budgetMonthOf(new Date('2026-04-01T05:30:00Z')).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z'
    );
  });
});

describe('resolveSaleEligibility', () => {
  it('schedules a sale that fits the budget, the lead time and the selection', () => {
    const r = resolveSaleEligibility(base);
    expect(r.canSchedule).toBe(true);
    expect(r.blockedReason).toBeUndefined();
    expect(r.eligibleVersions).toBe(5);
    expect(r.daysLeft).toBe(7);
  });

  it('blocks a creator below the score floor whatever their tier', () => {
    const r = resolveSaleEligibility({
      ...base,
      tier: 'gold',
      creatorScore: MIN_CREATOR_SCORE_FOR_SALE - 1,
    });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/creator score/);
  });

  it('blocks while a server check is still resolving, rather than offering a wrong answer', () => {
    const r = resolveSaleEligibility({ ...base, resolving: true });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/Checking/);
  });

  it('blocks when every selected version is early access, and speaks in the singular for one', () => {
    const all = resolveSaleEligibility({ ...base, eligibleCount: 0, earlyAccessCount: 5 });
    expect(all.canSchedule).toBe(false);
    expect(all.blockedReason).toMatch(/Every selected version is in early access/);

    const one = resolveSaleEligibility({
      ...base,
      selectedCount: 1,
      eligibleCount: 0,
      earlyAccessCount: 1,
    });
    expect(one.blockedReason).toMatch(/This version is in early access/);
  });

  // CU 868kwp6cx. A sale composes over a permanent access price and nothing else, so one scheduled over
  // versions that have no such price is created, reports itself as covering them, and then discounts
  // nothing on the card, the model page or the charge. This is the exact shape of the sale a creator
  // scheduled on 2026-08-25 — 20% off, five versions, no gate on any of them.
  //
  // 🔴 If you are removing this because the picker already filters the list: the picker is a list, and
  // the ids reach this form through the URL. A bookmark, a back button or a price cleared between
  // picking and submitting all arrive here with a selection the list would no longer show.
  it('blocks a sale over versions with no access price to discount', () => {
    const all = resolveSaleEligibility({
      ...base,
      type: 'Percent',
      amount: 20,
      eligibleCount: 0,
      unpricedCount: 5,
    });
    expect(all.canSchedule).toBe(false);
    expect(all.blockedReason).toMatch(/None of the selected versions has a permanent access price/);

    const one = resolveSaleEligibility({
      ...base,
      selectedCount: 1,
      eligibleCount: 0,
      unpricedCount: 1,
    });
    expect(one.blockedReason).toMatch(/This version has no permanent access price/);
  });

  // Both counts come off the same total, so adding them rather than taking the larger is what keeps a
  // selection that is entirely unschedulable from reporting versions it would cover.
  it('counts unpriced and early-access versions as separate shortfalls', () => {
    const mixed = resolveSaleEligibility({
      ...base,
      eligibleCount: 0,
      earlyAccessCount: 2,
      unpricedCount: 3,
    });
    expect(mixed.canSchedule).toBe(false);
    expect(mixed.eligibleVersions).toBe(0);

    const partial = resolveSaleEligibility({
      ...base,
      eligibleCount: 3,
      earlyAccessCount: 1,
      unpricedCount: 1,
    });
    expect(partial.canSchedule).toBe(true);
    // Kept APART, not summed. The notice names one reason per count, and a single `skipped` forced it to
    // pick one — it told the creator three unpriced versions were in early access.
    expect(partial.partialNotice).toEqual({ earlyAccess: 1, unpriced: 1, applies: 3 });
  });

  // The two arms are one keystroke apart and every count stays correct when they are swapped, so the
  // MESSAGE is what has to be asserted.
  it('names the reason that actually applies, including when both do', () => {
    const allEarly = resolveSaleEligibility({
      ...base,
      eligibleCount: 0,
      earlyAccessCount: 5,
      unpricedCount: 0,
    });
    expect(allEarly.blockedReason).toMatch(/early access/);
    expect(allEarly.blockedReason).not.toMatch(/permanent access price/);

    const allUnpriced = resolveSaleEligibility({
      ...base,
      eligibleCount: 0,
      earlyAccessCount: 0,
      unpricedCount: 5,
    });
    expect(allUnpriced.blockedReason).toMatch(/permanent access price/);
    expect(allUnpriced.blockedReason).not.toMatch(/early access/);

    const mixed = resolveSaleEligibility({
      ...base,
      eligibleCount: 0,
      earlyAccessCount: 2,
      unpricedCount: 3,
    });
    expect(mixed.blockedReason).toMatch(/early access/);
    expect(mixed.blockedReason).toMatch(/permanent access price/);
  });

  // 🔴 The server's own count, never `selected - skipped`. A selected id the creator no longer owns —
  // deleted, transferred, never theirs — is in neither skip count, so subtracting reports it as covered
  // and the form names a coverage the write does not deliver.
  it('takes the covered count from the server rather than subtracting', () => {
    const stale = resolveSaleEligibility({
      ...base,
      selectedCount: 3,
      eligibleCount: 1,
      earlyAccessCount: 0,
      unpricedCount: 1,
    });
    expect(stale.eligibleVersions).toBe(1);
    expect(stale.partialNotice).toEqual({ earlyAccess: 0, unpriced: 1, applies: 1 });
  });

  // 🔴 A preview that FAILED is not a preview that found nothing in the way. Resetting the counts to 0
  // on failure read as "all 5 selected versions are covered", offered Apply, and the write then refused
  // it — and for a Percent sale the floor check that guards the other unknown never runs.
  it('blocks when the coverage check did not come back', () => {
    const unknown = resolveSaleEligibility({
      ...base,
      type: 'Percent',
      amount: 20,
      eligibleCount: undefined,
      earlyAccessCount: undefined,
      unpricedCount: undefined,
    });
    expect(unknown.canSchedule).toBe(false);
    expect(unknown.blockedReason).toMatch(/Couldn't check which versions can go on sale/);
    expect(unknown.eligibleVersions).toBe(0);
    expect(unknown.partialNotice).toBeUndefined();
  });

  it('still schedules a partly-early-access selection and reports the shortfall', () => {
    const r = resolveSaleEligibility({ ...base, eligibleCount: 3, earlyAccessCount: 2 });
    expect(r.canSchedule).toBe(true);
    expect(r.partialNotice).toEqual({ earlyAccess: 2, unpriced: 0, applies: 3 });
  });

  it('carries no partial notice once it is blocked outright — the reason says it', () => {
    const r = resolveSaleEligibility({ ...base, eligibleCount: 0, earlyAccessCount: 5 });
    expect(r.partialNotice).toBeUndefined();
  });

  it('refuses a start beyond the lead time but allows one exactly on it', () => {
    const tooFar = resolveSaleEligibility({ ...base, startsAt: days(MAX_SALE_LEAD_DAYS + 1) });
    expect(tooFar.canSchedule).toBe(false);
    expect(tooFar.blockedReason).toMatch(/at most 14 days/);

    const onTheLine = resolveSaleEligibility({ ...base, startsAt: days(MAX_SALE_LEAD_DAYS) });
    expect(onTheLine.canSchedule).toBe(true);
  });

  it('refuses a sale longer than the days left, and says how many are left', () => {
    const r = resolveSaleEligibility({ ...base, daysUsedInMonth: 5, draftDays: 3 });
    expect(r.canSchedule).toBe(false);
    expect(r.daysLeft).toBe(2);
    expect(r.blockedReason).toMatch(/3 days, and you have 2 of 7 left/);
  });

  it('says the budget is gone rather than quoting a remainder of zero', () => {
    const r = resolveSaleEligibility({ ...base, daysUsedInMonth: 7 });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/no sale-days left/);
  });

  it('allows a sale that exactly exhausts the budget', () => {
    const r = resolveSaleEligibility({ ...base, daysUsedInMonth: 4, draftDays: 3 });
    expect(r.canSchedule).toBe(true);
    expect(r.daysLeft).toBe(3);
  });

  it('never reports a negative remainder when a tier drop leaves days over-committed', () => {
    // A creator can lapse from gold to free mid-month with 20 days already committed.
    const r = resolveSaleEligibility({ ...base, tier: 'free', daysUsedInMonth: 20 });
    expect(r.daysLeft).toBe(0);
    expect(r.blockedReason).toMatch(/no sale-days left/);
  });

  it('checks the score before anything else, so the floor is never masked by a fixable problem', () => {
    const r = resolveSaleEligibility({
      ...base,
      creatorScore: 100,
      daysUsedInMonth: 7,
      startsAt: days(30),
    });
    expect(r.blockedReason).toMatch(/creator score/);
  });
});

describe('resolveSaleEligibility — a sale may never take a version to zero', () => {
  it('refuses more than 99% off', () => {
    const r = resolveSaleEligibility({ ...base, type: 'Percent', amount: 100 });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/at most 99%/);
  });

  it('allows exactly 99%', () => {
    expect(resolveSaleEligibility({ ...base, type: 'Percent', amount: 99 }).canSchedule).toBe(true);
  });

  it('refuses a fixed discount that meets the cheapest covered price', () => {
    // The floor is the cheapest of the SELECTION, not each version: "500 off" across versions at 500
    // and 2000 still zeroes the first, which is the case the per-version reading would miss.
    const r = resolveSaleEligibility({
      ...base,
      type: 'Fixed',
      amount: 500,
      minCoveredPrice: 500,
    });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/to zero/);
  });

  it('allows a fixed discount one Buzz under the floor', () => {
    const r = resolveSaleEligibility({
      ...base,
      type: 'Fixed',
      amount: 499,
      minCoveredPrice: 500,
    });
    expect(r.canSchedule).toBe(true);
  });

  it('does not refuse a fixed discount when nothing in the selection is priced yet', () => {
    const r = resolveSaleEligibility({
      ...base,
      type: 'Fixed',
      amount: 9999,
      minCoveredPrice: null,
    });
    expect(r.canSchedule).toBe(true);
  });

  it('says nothing about zeroing before the creator has typed an amount', () => {
    const r = resolveSaleEligibility({ ...base, type: 'Fixed', amount: undefined });
    expect(r.canSchedule).toBe(true);
  });
});

describe('resolveSaleDraft', () => {
  const ctx = {
    selectedCount: 5,
    eligibleCount: 5,
    earlyAccessCount: 0,
    unpricedCount: 0,
    minCoveredPrice: 500,
    creatorScore: 25_000,
    tier: 'bronze',
    sales: [],
    resolving: false,
  };
  const input = {
    type: 'Percent' as const,
    amount: 20,
    startDate: '2026-03-11',
    endDate: '2026-03-13',
  };

  it('reads the last day as inclusive and ends the window at the following midnight', () => {
    const d = resolveSaleDraft(input, ctx, NOW);
    expect(d.startsAt?.toISOString()).toBe('2026-03-11T00:00:00.000Z');
    expect(d.endsAt?.toISOString()).toBe('2026-03-14T00:00:00.000Z');
    // The 11th, 12th and 13th — three days, which is what a creator picking those dates means.
    expect(d.draftDays).toBe(3);
  });

  it('spends against the month the sale starts in, even when it runs into the next', () => {
    const d = resolveSaleDraft(
      { ...input, startDate: '2026-03-30', endDate: '2026-04-02' },
      ctx,
      NOW
    );
    expect(d.budgetMonth?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('blocks on an unset window without claiming the sale is too long', () => {
    const d = resolveSaleDraft({ ...input, startDate: '', endDate: '' }, ctx, NOW);
    expect(d.eligibility.canSchedule).toBe(false);
    expect(d.eligibility.blockedReason).toMatch(/Choose the days/);
  });

  it('🔴 blocks while sales are unknown — an unloaded budget must never read as an unused one', () => {
    const d = resolveSaleDraft(input, { ...ctx, sales: null }, NOW);
    expect(d.eligibility.canSchedule).toBe(false);
  });

  it('counts days already committed in that month against the budget', () => {
    const d = resolveSaleDraft(
      { ...input, startDate: '2026-03-20', endDate: '2026-03-24' },
      {
        ...ctx,
        sales: [
          {
            id: 1,
            discountType: 'Percent' as const,
            discountAmount: 10,
            startsAt: new Date('2026-03-02T00:00:00Z'),
            endsAt: new Date('2026-03-06T00:00:00Z'),
          },
        ],
      },
      NOW
    );
    expect(d.daysUsedInMonth).toBe(4);
    // bronze is 7: 4 spent, 5 asked for.
    expect(d.eligibility.canSchedule).toBe(false);
    expect(d.eligibility.blockedReason).toMatch(/5 days, and you have 3 of 7 left/);
  });
});

describe('resolveSaleEligibility — bounds a forged or mistyped window', () => {
  it('refuses a start before today, which would spend an untouched budget from a past month', () => {
    // saleDaysUsed buckets by START month, so one backdated sale per prior month runs concurrently
    // with this month's on a budget nothing has spent.
    const r = resolveSaleEligibility({ ...base, startsAt: days(-1) });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/can't start in the past/);
  });

  it('allows a start earlier today than now — the day is the unit, not the instant', () => {
    const r = resolveSaleEligibility({ ...base, startsAt: new Date('2026-03-10T00:00:00Z') });
    expect(r.canSchedule).toBe(true);
  });

  it('🔴 blocks a Fixed discount when the price floor could not be resolved', () => {
    // undefined is "not known" — a failed preview. Treating it as "no floor" is how a discount nothing
    // evaluated reaches Apply.
    const r = resolveSaleEligibility({
      ...base,
      type: 'Fixed',
      amount: 400,
      minCoveredPrice: undefined,
    });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/Couldn't check the prices/);
  });

  it('allows a Fixed discount when nothing in the selection is priced (null, not undefined)', () => {
    const r = resolveSaleEligibility({
      ...base,
      type: 'Fixed',
      amount: 400,
      minCoveredPrice: null,
    });
    expect(r.canSchedule).toBe(true);
  });
});

describe('resolveSaleEligibility — operator overrides from the KeyValue row', () => {
  const overrides = { saleDaysByTier: { bronze: 20 }, minCreatorScore: 50_000, maxLeadDays: 30 };

  it('spends the overridden allowance rather than the compiled one', () => {
    const r = resolveSaleEligibility({
      ...base,
      creatorScore: 60_000,
      daysUsedInMonth: 10,
      overrides,
    });
    expect(r.daysAllowed).toBe(20);
    expect(r.canSchedule).toBe(true);
  });

  it('applies an overridden score floor', () => {
    const r = resolveSaleEligibility({ ...base, creatorScore: 25_000, overrides });
    expect(r.canSchedule).toBe(false);
    expect(r.blockedReason).toMatch(/50,000/);
  });

  it('applies an overridden lead time', () => {
    const r = resolveSaleEligibility({
      ...base,
      creatorScore: 60_000,
      startsAt: days(25),
      overrides,
    });
    expect(r.canSchedule).toBe(true);
  });

  it('leaves every unmentioned limit at its default', () => {
    const r = resolveSaleEligibility({
      ...base,
      startsAt: days(20),
      overrides: { minCreatorScore: 1 },
    });
    expect(r.blockedReason).toMatch(/at most 14 days/);
  });
});

describe('resolveSaleUndercut', () => {
  const sale = (over: Partial<ModelVersionSaleWindow> = {}): ModelVersionSaleWindow => ({
    id: 1,
    discountType: 'Percent',
    discountAmount: 20,
    startsAt: days(-1),
    endsAt: days(5),
    ...over,
  });

  it('says nothing when no sale covers the version', () => {
    expect(resolveSaleUndercut({ sales: [], storedPrice: 1000, newPrice: 800 }, NOW)).toBeNull();
  });

  it('quotes what buyers pay at the new price, and does not warn when the price rises', () => {
    const r = resolveSaleUndercut({ sales: [sale()], storedPrice: 1000, newPrice: 1200 }, NOW);
    expect(r?.newSalePrice).toBe(960);
    expect(r?.undercuts).toBe(false);
  });

  it('warns when the new base takes buyers below what the sale advertises', () => {
    const r = resolveSaleUndercut({ sales: [sale()], storedPrice: 1000, newPrice: 500 }, NOW);
    expect(r?.currentSalePrice).toBe(800);
    expect(r?.newSalePrice).toBe(400);
    expect(r?.undercuts).toBe(true);
  });

  it('🔴 quotes the sale applying TODAY, not the one the new price would pick', () => {
    // Percent 60 and Fixed 500 overlap. At the stored 2000 the percent wins (buyers pay 800); at a
    // typed 700 the fixed wins. Reusing the new price's winner would claim buyers pay 1500 today.
    const sales = [
      sale({ discountAmount: 60 }),
      sale({ id: 2, discountType: 'Fixed', discountAmount: 500 }),
    ];
    const r = resolveSaleUndercut({ sales, storedPrice: 2000, newPrice: 700 }, NOW);
    expect(r?.currentSalePrice).toBe(800);
  });
});

describe('the offered last day and the budget agree', () => {
  // The picker offers `start + (daysLeft - 1)` as its max. If that is off by one against
  // saleLengthInDays, the form hands the creator a date the save then refuses — worse than no bound,
  // because the picker told them it was allowed.
  const ctx = {
    selectedCount: 1,
    eligibleCount: 1,
    earlyAccessCount: 0,
    unpricedCount: 0,
    minCoveredPrice: 500,
    creatorScore: 25_000,
    tier: 'bronze',
    sales: [
      {
        id: 1,
        discountType: 'Percent' as const,
        discountAmount: 10,
        startsAt: new Date('2026-03-02T00:00:00Z'),
        endsAt: new Date('2026-03-07T00:00:00Z'),
      },
    ],
    resolving: false,
  };
  const input = { type: 'Percent' as const, amount: 20, startDate: '2026-03-11', endDate: '' };

  it('leaves exactly the days the picker would offer', () => {
    // bronze 7, five spent by the fixture above.
    expect(
      resolveSaleDraft({ ...input, endDate: '2026-03-11' }, ctx, NOW).eligibility.daysLeft
    ).toBe(2);
  });

  it('accepts a window ending on the offered maximum', () => {
    // daysLeft 2 → offered max is start + 1 day.
    const d = resolveSaleDraft({ ...input, endDate: '2026-03-12' }, ctx, NOW);
    expect(d.draftDays).toBe(2);
    expect(d.eligibility.canSchedule).toBe(true);
  });

  it('refuses the day after it, so the bound is not one short or one long', () => {
    const d = resolveSaleDraft({ ...input, endDate: '2026-03-13' }, ctx, NOW);
    expect(d.draftDays).toBe(3);
    expect(d.eligibility.canSchedule).toBe(false);
  });
});

describe('shortenBounds', () => {
  // A sale scheduled 11th-13th inclusive is stored as endsAt = the 14th.
  const sale = {
    startsAt: new Date('2026-03-11T00:00:00Z'),
    endsAt: new Date('2026-03-14T00:00:00Z'),
  };

  it('offers up to the day BEFORE the current last day, not the last day itself', () => {
    // The action stores picked + 1 day. Offering the 13th would reproduce the current end, which the
    // UPDATE refuses — a button that always fails. So the 12th is the latest useful choice.
    const b = shortenBounds(sale, new Date('2026-03-11T12:00:00Z'));
    expect(b.max.toISOString().slice(0, 10)).toBe('2026-03-12');
    expect(b.possible).toBe(true);
  });

  it('never offers a day already past — the floor is now, not the start', () => {
    const b = shortenBounds(sale, new Date('2026-03-12T09:00:00Z'));
    expect(b.min.toISOString().slice(0, 10)).toBe('2026-03-12');
    // 🔴 And it is still shortenable. `max` is midnight-aligned while `now` carries a time of day, so
    // comparing them as instants declared a two-day sale finished from 00:00 on its second-to-last day —
    // the control vanished and the creator was told their sale was on its last day when it was not.
    expect(b.possible).toBe(true);
  });

  it('compares days, not instants, at every hour of the latest offerable day', () => {
    for (const hour of ['00:00', '09:00', '23:59']) {
      const b = shortenBounds(sale, new Date(`2026-03-12T${hour}:00Z`));
      expect({ hour, possible: b.possible }).toEqual({ hour, possible: true });
    }
  });

  it('floors at the start for a sale that has not begun', () => {
    const b = shortenBounds(sale, new Date('2026-03-01T00:00:00Z'));
    expect(b.min.toISOString().slice(0, 10)).toBe('2026-03-11');
  });

  it('reports a one-day sale as unshortenable rather than offering an impossible range', () => {
    const oneDay = {
      startsAt: new Date('2026-03-11T00:00:00Z'),
      endsAt: new Date('2026-03-12T00:00:00Z'),
    };
    expect(shortenBounds(oneDay, new Date('2026-03-11T06:00:00Z')).possible).toBe(false);
  });

  it('reports a sale on its final day as unshortenable', () => {
    expect(shortenBounds(sale, new Date('2026-03-13T06:00:00Z')).possible).toBe(false);
  });
});

// The `?/salePreview` wire is string-keyed and nothing type-checks it. The page used to read
// `Number(data?.unpriced ?? 0)`, so renaming the key on the server silently produced zeroes — which
// resolveSaleEligibility reads as "everything you selected is covered".
describe('parseSalePreview', () => {
  const payload = { eligible: 3, earlyAccess: 1, unpriced: 1, minCoveredPrice: 500 };

  it('reads a well-formed payload', () => {
    expect(parseSalePreview(payload)).toEqual(payload);
  });

  it('treats a null floor as "none priced", not as missing', () => {
    expect(parseSalePreview({ ...payload, minCoveredPrice: null })?.minCoveredPrice).toBeNull();
  });

  // 🔴 `null` is the value that SKIPS the Fixed zero-floor check, so a garbage floor must not degrade
  // into it — that waves through any fixed discount rather than blocking on an unknown.
  it('refuses a floor that is neither a number nor null', () => {
    expect(parseSalePreview({ ...payload, minCoveredPrice: '500' })).toBeUndefined();
    const dropped: Record<string, unknown> = { ...payload };
    delete dropped.minCoveredPrice;
    expect(parseSalePreview(dropped)).toBeUndefined();
  });

  // 🔴 undefined, never zeroes. A renamed or dropped key is an answer we did not get, and the form
  // blocks on that — the whole point of the type on the other side of this wire.
  it('returns undefined when a count is missing or the wrong shape', () => {
    const missing: Record<string, unknown> = { ...payload };
    delete missing.unpriced;
    expect(parseSalePreview(missing)).toBeUndefined();
    expect(parseSalePreview({ ...payload, unpriced: '1' })).toBeUndefined();
    expect(parseSalePreview({ ...payload, eligible: NaN })).toBeUndefined();
    expect(parseSalePreview(undefined)).toBeUndefined();
    expect(parseSalePreview(null)).toBeUndefined();
  });
});
