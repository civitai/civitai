import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { UserMultiplierRow } from '~/server/redis/user-multipliers';
import { foldUserMultipliers } from '~/server/redis/user-multipliers';

const paidBronze = (userId: number): UserMultiplierRow => ({
  userId,
  rewardsIneligible: false,
  rewardsMultiplier: 1.5,
  purchasesMultiplier: 1.05,
});

const referralGrant = (userId: number): UserMultiplierRow => ({
  userId,
  rewardsIneligible: false,
  rewardsMultiplier: null,
  purchasesMultiplier: null,
});

const buzzPurchaseGrant = (userId: number): UserMultiplierRow => ({
  userId,
  rewardsIneligible: false,
  rewardsMultiplier: 1,
  purchasesMultiplier: 1,
});

describe('foldUserMultipliers', () => {
  it('a perkless referral grant must not shadow a paid membership', () => {
    // Do not "simplify" this back to picking one winning row. A referral grant conveys a tier and
    // no perks, and out-ranked the paid row on the currentPeriodEnd tiebreak (ClickUp 868kv4q7t).
    const result = foldUserMultipliers([referralGrant(1), paidBronze(1)]);

    expect(result[1].rewardsMultiplier).toBe(1.5);
    expect(result[1].purchasesMultiplier).toBe(1.05);
  });

  it('is order-independent, because row order is not part of the contract', () => {
    const result = foldUserMultipliers([paidBronze(2), referralGrant(2)]);

    expect(result[2].rewardsMultiplier).toBe(1.5);
    expect(result[2].purchasesMultiplier).toBe(1.05);
  });

  it('a civitai-buzz-* grant carrying an explicit 1 must not shadow it either', () => {
    const result = foldUserMultipliers([buzzPurchaseGrant(3), paidBronze(3)]);

    expect(result[3].rewardsMultiplier).toBe(1.5);
    expect(result[3].purchasesMultiplier).toBe(1.05);
  });

  it('falls back to 1 when the only active row carries no perks', () => {
    const result = foldUserMultipliers([referralGrant(4)]);

    expect(result[4].rewardsMultiplier).toBe(1);
    expect(result[4].purchasesMultiplier).toBe(1);
  });

  it('takes the best across tiers rather than the highest tier', () => {
    const activeGoldGrant: UserMultiplierRow = {
      userId: 5,
      rewardsIneligible: false,
      rewardsMultiplier: null,
      purchasesMultiplier: null,
    };
    const paidSilver: UserMultiplierRow = {
      userId: 5,
      rewardsIneligible: false,
      rewardsMultiplier: 2.5,
      purchasesMultiplier: 1.1,
    };

    const result = foldUserMultipliers([activeGoldGrant, paidSilver]);

    expect(result[5].rewardsMultiplier).toBe(2.5);
  });

  it('zeroes rewards for an ineligible user without touching purchases', () => {
    const result = foldUserMultipliers([
      { ...paidBronze(6), rewardsIneligible: true },
      { ...referralGrant(6), rewardsIneligible: true },
    ]);

    expect(result[6].rewardsMultiplier).toBe(0);
    expect(result[6].purchasesMultiplier).toBe(1.05);
    expect(result[6].rewardsIneligible).toBe(true);
  });

  it('keeps users separate', () => {
    const result = foldUserMultipliers([paidBronze(7), referralGrant(8)]);

    expect(result[7].rewardsMultiplier).toBe(1.5);
    expect(result[8].rewardsMultiplier).toBe(1);
  });

  it('keeps a multiplier below 1 rather than flooring it to 1', () => {
    // A penalty tier is not in the catalogue today, but the query this replaced honoured a value
    // below 1 and nothing should quietly turn one into a no-op if it is ever added.
    const penalty: UserMultiplierRow = {
      userId: 9,
      rewardsIneligible: false,
      rewardsMultiplier: 0.5,
      purchasesMultiplier: 0.5,
    };

    const result = foldUserMultipliers([penalty]);

    expect(result[9].rewardsMultiplier).toBe(0.5);
    expect(result[9].purchasesMultiplier).toBe(0.5);
  });

  it('returns nothing for no rows', () => {
    expect(foldUserMultipliers([])).toEqual({});
  });
});

describe('userMultipliersCache wiring', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/server/redis/caches.ts'), 'utf-8');
  const start = source.indexOf('export const userMultipliersCache');
  // The next declaration, not a named neighbour: anchoring on an unrelated symbol reds this test
  // when that symbol is renamed, which says nothing about the multiplier lookup.
  const end = source.indexOf('export const ', start + 1);
  const lookup = source.slice(start, end);

  it('reads the source it is meant to read', () => {
    // Both bounds asserted: `indexOf` returning -1 makes `slice` widen to the whole file, and the
    // assertions below would then keep passing while bounding nothing.
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(lookup).toContain('MULTIPLIERS_FOR_USER');
  });

  // 🔴 A TRIPWIRE, NOT COVERAGE. The bug (ClickUp 868kv4q7t) lives in the SQL: the old query used
  // ROW_NUMBER() to pick ONE winning subscription row, so a perkless referral grant could shadow a
  // paid membership. `foldUserMultipliers` only helps if the query hands it EVERY active row, and
  // no unit test can see that — it would take a database.
  //
  // So this lists the ways single-winner selection gets reintroduced. It was written after the
  // first version, which pinned the literal string 'ROW_NUMBER()', passed a mutation to
  // `SELECT DISTINCT ON (u.id)` that restored the bug completely: 11 of 11 green, exit 0.
  // If you add a case, add it because you found another way through, not to be thorough.
  const singleWinnerIdioms = [
    /row_number\s*\(/i,
    /distinct\s+on/i,
    /\blimit\s+1\b/i,
    /\blateral\b/i,
  ];

  it.each(singleWinnerIdioms.map((re) => [re.source, re] as const))(
    'does not reintroduce single-winner selection via %s',
    (_label, re) => {
      expect(re.test(lookup)).toBe(false);
    }
  );

  it('resolves multipliers through foldUserMultipliers', () => {
    expect(lookup).toContain('foldUserMultipliers(');
  });

  // 🔴 ALSO A TRIPWIRE. `status` alone let a subscription whose period ended keep paying perks
  // indefinitely — 17 of 5,588 active rows on 2026-08-25, all carrying a multiplier above 1, the
  // oldest expired in February (ClickUp 868kw98pv). Whether the guard WORKS is a database question
  // and this cannot answer it; the A/B against the prod replica in the PR is that evidence.
  //
  // The comparison is pinned WITH its direction on purpose: asserting the column name alone passes
  // against `<= now()`, which restores the bug and inverts it for everyone else.
  it('gates the subscription join on the period still being open', () => {
    expect(lookup).toMatch(/"currentPeriodEnd"\s*>=\s*now\(\)/);
  });

  // The row an expired subscription now produces — every multiplier null — is the same shape a
  // perkless grant produces, and `falls back to 1 when the only active row carries no perks` above
  // already pins that it folds to 1 rather than to 0. Not repeated here.
});
