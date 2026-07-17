import { describe, it, expect } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { nsfwBrowsingLevelsFlag, sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import {
  deriveDomainCurrency,
  isNonSfwForGreen,
  isChallengeHiddenByDomainCurrency,
  computeNsfwEscalation,
} from './challenge-currency';

describe('deriveDomainCurrency', () => {
  it('returns green on the green domain', () => {
    expect(deriveDomainCurrency(true)).toBe('green');
  });
  it('returns yellow off the green domain', () => {
    expect(deriveDomainCurrency(false)).toBe('yellow');
  });
});

describe('isNonSfwForGreen', () => {
  it('rejects green + a non-SFW level', () => {
    expect(isNonSfwForGreen('green', nsfwBrowsingLevelsFlag)).toBe(true);
  });
  it('passes green + an SFW-only level', () => {
    expect(isNonSfwForGreen('green', sfwBrowsingLevelsFlag)).toBe(false);
  });
  it('always passes yellow, even with a non-SFW level', () => {
    expect(isNonSfwForGreen('yellow', nsfwBrowsingLevelsFlag)).toBe(false);
  });
});

describe('isChallengeHiddenByDomainCurrency', () => {
  const user = ChallengeSource.User;
  it('hides a yellow user challenge on the green domain', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ source: user, buzzType: 'yellow', createdById: 5 }, true, 99)
    ).toBe(true);
  });
  it('shows a green user challenge on the green domain', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ source: user, buzzType: 'green', createdById: 5 }, true, 99)
    ).toBe(false);
  });
  it('hides a green user challenge off the green domain', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ source: user, buzzType: 'green', createdById: 5 }, false, 99)
    ).toBe(true);
  });
  it('exempts the creator from the domain gate', () => {
    expect(
      isChallengeHiddenByDomainCurrency({ source: user, buzzType: 'yellow', createdById: 5 }, true, 5)
    ).toBe(false);
  });
  it('exempts non-user (System) challenges — yellow daily shows on the green domain', () => {
    expect(
      isChallengeHiddenByDomainCurrency(
        { source: ChallengeSource.System, buzzType: 'yellow', createdById: null },
        true,
        99
      )
    ).toBe(false);
  });
});

describe('computeNsfwEscalation', () => {
  const PG_PG13 = NsfwLevel.PG | NsfwLevel.PG13; // 3, SFW mask

  it('no-ops on a clean scan (nsfwLevel = derived base, no flip/refund)', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      basePrizePool: 100,
      isNsfw: false,
    });
    expect(r.allowedNsfwLevel).toBe(PG_PG13);
    expect(r.nsfwLevel).toBe(NsfwLevel.PG13); // maxValue(PG|PG13)
    expect(r.flip).toBe(false);
    expect(r.refundInitialPrize).toBe(false);
  });

  it('green user challenge + nsfw: raises to R, flips, refunds when a prize exists', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      basePrizePool: 100,
      isNsfw: true,
    });
    expect(r.allowedNsfwLevel).toBe(PG_PG13 | NsfwLevel.R); // 7
    expect(r.nsfwLevel).toBe(NsfwLevel.R);
    expect(r.flip).toBe(true);
    expect(r.refundInitialPrize).toBe(true);
  });

  it('green user challenge + nsfw with no prize: flips but no refund', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      basePrizePool: 0,
      isNsfw: true,
    });
    expect(r.flip).toBe(true);
    expect(r.refundInitialPrize).toBe(false);
  });

  it('yellow user challenge + nsfw: raises to R but does not flip or refund', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'yellow',
      source: ChallengeSource.User,
      basePrizePool: 100,
      isNsfw: true,
    });
    expect(r.allowedNsfwLevel).toBe(PG_PG13 | NsfwLevel.R);
    expect(r.nsfwLevel).toBe(NsfwLevel.R);
    expect(r.flip).toBe(false);
    expect(r.refundInitialPrize).toBe(false);
  });

  it('non-user (System) challenge + nsfw: raises to R, never flips', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.System,
      basePrizePool: 100,
      isNsfw: true,
    });
    expect(r.flip).toBe(false);
    expect(r.refundInitialPrize).toBe(false);
  });
});
