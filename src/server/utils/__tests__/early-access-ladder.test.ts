import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import {
  chapterEarlyAccessCapMessage,
  chapterEarlyAccessLockedMessage,
  getEarlyAccessEntryRung,
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';

// The ladder had no assertions at all until 2026-09-04, so the score it reads could be swapped
// without a single test printing anything. These pin the field, not the rungs: the rung values come
// from EARLY_ACCESS_CONFIG so a deliberate re-tiering doesn't redden them — which is what let the
// entry rung move 40,000 -> 10,000 without touching a line here.

const [firstDayScore, firstDays] = EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock[0] as [number, number];
const [secondDayScore, secondDays] = EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock[1] as [
  number,
  number
];
const [firstQtyScore, firstQty] = EARLY_ACCESS_CONFIG.scoreQuantityUnlock[0] as [number, number];

describe('getMaxEarlyAccessDays', () => {
  it('reads the creator score even when the models score is 0', () => {
    expect(
      getMaxEarlyAccessDays({ userMeta: { scores: { total: secondDayScore, models: 0 } } })
    ).toBe(secondDays);
  });

  // Its own test on purpose: paired with the one above it would be masked by that assertion
  // failing first, and this is the direction that actually pins the field.
  it('ignores a models score that would clear every rung', () => {
    expect(getMaxEarlyAccessDays({ userMeta: { scores: { total: 0, models: 250_000 } } })).toBe(0);
  });

  it('gives nothing below the first rung', () => {
    expect(getMaxEarlyAccessDays({ userMeta: { scores: { total: firstDayScore - 1 } } })).toBe(0);
    expect(getMaxEarlyAccessDays({ userMeta: { scores: { total: firstDayScore } } })).toBe(
      firstDays
    );
  });

  // `total` is the sum of six categories and reportsAgainst is negative, so unlike the old models
  // score this can arrive below zero. A penalised account must not reach a rung.
  it('gives nothing to a negative score', () => {
    expect(getMaxEarlyAccessDays({ userMeta: { scores: { total: -1_500 } } })).toBe(0);
  });

  it('treats absent meta as no access', () => {
    expect(getMaxEarlyAccessDays({})).toBe(0);
    expect(getMaxEarlyAccessDays({ userMeta: {} })).toBe(0);
  });

  // The flag entry is last in the config and `[length - 1]` wins, so it outranks every score rung.
  // Pinned because a future reordering of the config would silently take it away.
  it('lets the thirtyDayEarlyAccess flag beat every score rung', () => {
    const features = { thirtyDayEarlyAccess: true } as never;
    const [, flagDays] = EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock.at(-1) as [unknown, number];
    const [topScore, topDays] = EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock.at(-2) as [number, number];
    // The score must clear the TOP rung, or there is nothing for the flag to beat and this passes
    // just as well when the flag is the only thing granting anything.
    const withFlag = getMaxEarlyAccessDays({ userMeta: { scores: { total: topScore } }, features });
    expect(withFlag).toBe(flagDays);
    expect(withFlag).not.toBe(topDays);
  });
});

describe('getMaxEarlyAccessModels', () => {
  it('reads the creator score even when the models score is 0', () => {
    expect(
      getMaxEarlyAccessModels({ userMeta: { scores: { total: firstQtyScore, models: 0 } } })
    ).toBe(firstQty);
  });

  it('ignores a models score that would clear every rung', () => {
    expect(getMaxEarlyAccessModels({ userMeta: { scores: { total: 0, models: 250_000 } } })).toBe(
      0
    );
  });

  it('gives nothing to a negative score', () => {
    expect(getMaxEarlyAccessModels({ userMeta: { scores: { total: -1_500 } } })).toBe(0);
  });

  // Every other test here lands on rung 0 or on nothing, so without this the `[length - 1]` pick is
  // never exercised and swapping it for `[0]` would drop a top creator to the entry allowance.
  it('takes the highest rung the score clears, not the first', () => {
    // -2, not -1: the last entry is the feature-flag rung, whose "score" is a predicate.
    const [score, qty] = EARLY_ACCESS_CONFIG.scoreQuantityUnlock.at(-2) as [number, number];
    expect(getMaxEarlyAccessModels({ userMeta: { scores: { total: score } } })).toBe(qty);
    expect(qty).not.toBe(firstQty);
  });

  it('lets the thirtyDayEarlyAccess flag beat every score rung', () => {
    const features = { thirtyDayEarlyAccess: true } as never;
    const flagEntry = EARLY_ACCESS_CONFIG.scoreQuantityUnlock.find(
      ([score]) => typeof score === 'function'
    ) as [unknown, number] | undefined;
    // Asserted rather than skipped: the days ladder has a flag rung and this one is expected to
    // match it. If the entry is ever removed, this should be a decision, not a silent pass.
    expect(flagEntry).toBeDefined();
    expect(getMaxEarlyAccessModels({ userMeta: { scores: { total: 0 } }, features })).toBe(
      (flagEntry as [unknown, number])[1]
    );
  });
});

describe('getEarlyAccessEntryRung', () => {
  // Read through the same functions the gates use, so the locked copy cannot promise what the
  // editor would not then allow.
  it('opens where both gates first grant something, with what they grant there', () => {
    const rung = getEarlyAccessEntryRung();
    expect(rung).not.toBeNull();
    const { minScore, days, versions } = rung as NonNullable<typeof rung>;
    expect(getMaxEarlyAccessDays({ userMeta: { scores: { total: minScore - 1 } } })).toBe(0);
    expect(getMaxEarlyAccessDays({ userMeta: { scores: { total: minScore } } })).toBe(days);
    expect(getMaxEarlyAccessModels({ userMeta: { scores: { total: minScore } } })).toBe(versions);
    expect(days).toBeGreaterThan(0);
    expect(versions).toBeGreaterThan(0);
  });

  // The two entry rungs are equal in today's config, so only a config where they differ can tell
  // "the later of the two" from "the earlier".
  it('waits for the later gate when the two entry rungs differ', () => {
    expect(
      getEarlyAccessEntryRung({
        scoreTimeFrameUnlock: [
          [1_000, 3],
          [5_000, 5],
        ],
        scoreQuantityUnlock: [[4_000, 2]],
      })
    ).toEqual({ minScore: 4_000, days: 3, versions: 2 });
  });
});

describe('chapter early-access refusals', () => {
  const rung = getEarlyAccessEntryRung() as NonNullable<ReturnType<typeof getEarlyAccessEntryRung>>;

  it('names the entry score and where the creator stands', () => {
    expect(chapterEarlyAccessLockedMessage(1234.9)).toBe(
      `Early access for chapters unlocks at a Creator Score of ${rung.minScore.toLocaleString(
        'en-US'
      )}. You're at 1,234.`
    );
  });

  it('says nothing about a score it was not given', () => {
    expect(chapterEarlyAccessLockedMessage(undefined)).not.toMatch(/You're at/);
  });

  it('tells a creator below the top of the ladder that the cap rises', () => {
    expect(chapterEarlyAccessCapMessage({ active: 1, score: rung.minScore })).toBe(
      `You already have 1 chapter in early access, the most your Creator Score of ${rung.minScore.toLocaleString(
        'en-US'
      )} allows. Higher scores raise it.`
    );
  });

  it('promises no rise above the top quantity rung', () => {
    const [topScore] = EARLY_ACCESS_CONFIG.scoreQuantityUnlock.at(-2) as [number, number];
    expect(chapterEarlyAccessCapMessage({ active: 3, score: topScore })).not.toMatch(/raise/);
  });
});
