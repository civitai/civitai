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

  // `Math.max` here is a max ACROSS ROWS, not a floor, and the values come from operator-authored
  // `Product.metadata` via `(...)::float` — a column that accepts a negative, `Infinity` and `NaN`.
  // These reach the award computation and the Redis Lua cap script (ClickUp 868m06pn5).
  it('floors a negative multiplier at 0 rather than carrying it', () => {
    const typo: UserMultiplierRow = {
      userId: 10,
      rewardsIneligible: false,
      rewardsMultiplier: -1,
      purchasesMultiplier: -3,
    };

    const result = foldUserMultipliers([typo]);

    // 0, not 1: a zero already means "earns nothing" everywhere downstream, and flooring to 1 would
    // invent a payout out of a typo.
    expect(result[10].rewardsMultiplier).toBe(0);
    // 🔴 And purchases is NOT floored, asserted at the producer where the symmetry edit is tempting
    // — the comment forbidding it is two lines from the code, and the only other test covering this
    // decision lives in a file that mocks this function away entirely. A 0 here credits a completed
    // Buzz purchase with nothing; see buzz.service.multiplier-floor.test.ts for the mechanism.
    expect(result[10].purchasesMultiplier).toBe(-3);
  });

  // The floor is applied at TWO places, both on the rewards side: the first-row assignment and the
  // `Math.max` merge arm. Every other test here gives a user ONE row, so only the first branch ran
  // — reverting the merge arm alone left the whole file green. A multi-row user is the reason this
  // fold exists. (`purchasesMultiplier` is deliberately NOT floored; see the buzz.service test.)
  it('floors a bad SECOND row, not only the first one it sees', () => {
    const bad = (rewardsMultiplier: number): UserMultiplierRow => ({
      userId: 14,
      rewardsIneligible: false,
      rewardsMultiplier,
      purchasesMultiplier: 1,
    });

    // Negative control: the second row must actually reach the merge arm. A row that never merges
    // would make the assertions below pass against an untouched first-row value.
    expect(foldUserMultipliers([paidBronze(14), bad(9)])[14].rewardsMultiplier).toBe(9);

    // `Math.max(1.5, NaN)` is NaN and `Math.max(1.5, Infinity)` is Infinity, so an unfloored merge
    // arm lets one bad row poison a membership the user is paying for.
    expect(foldUserMultipliers([paidBronze(14), bad(NaN)])[14].rewardsMultiplier).toBe(1.5);
    expect(foldUserMultipliers([paidBronze(14), bad(Infinity)])[14].rewardsMultiplier).toBe(1.5);
    // No negative case here on purpose: `Math.max(1.5, -1)` is 1.5 floored or not, so the merge arm
    // cannot be caught with one. The first-row arm covers negatives, in the test above.
  });

  it('replaces a non-finite multiplier by sign', () => {
    const rows: UserMultiplierRow[] = [
      {
        userId: 12,
        rewardsIneligible: false,
        rewardsMultiplier: Infinity,
        purchasesMultiplier: 1,
      },
      {
        userId: 13,
        rewardsIneligible: false,
        rewardsMultiplier: -Infinity,
        purchasesMultiplier: 1,
      },
    ];

    const result = foldUserMultipliers(rows);

    // Infinity and NaN take the base multiplier; a negative infinity is still a negative and must
    // not come out worth more than -5 does.
    expect(result[12].rewardsMultiplier).toBe(1);
    expect(result[13].rewardsMultiplier).toBe(0);
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
