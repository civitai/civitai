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

  it('clean scan: nsfwLevel = derived base, no cancel', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      isNsfw: false,
    });
    expect(r.allowedNsfwLevel).toBe(PG_PG13);
    expect(r.nsfwLevel).toBe(NsfwLevel.PG13);
    expect(r.cancel).toBe(false);
  });

  it('green user challenge + nsfw: cancel, level left unchanged', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.User,
      isNsfw: true,
    });
    expect(r.cancel).toBe(true);
    expect(r.allowedNsfwLevel).toBe(PG_PG13);
    expect(r.nsfwLevel).toBe(NsfwLevel.PG13);
  });

  it('yellow user challenge + nsfw: raise to R, no cancel', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'yellow',
      source: ChallengeSource.User,
      isNsfw: true,
    });
    expect(r.cancel).toBe(false);
    expect(r.allowedNsfwLevel).toBe(PG_PG13 | NsfwLevel.R);
    expect(r.nsfwLevel).toBe(NsfwLevel.R);
  });

  it('non-user (System) green challenge + nsfw: raise to R, never cancel', () => {
    const r = computeNsfwEscalation({
      allowedNsfwLevel: PG_PG13,
      buzzType: 'green',
      source: ChallengeSource.System,
      isNsfw: true,
    });
    expect(r.cancel).toBe(false);
    expect(r.allowedNsfwLevel).toBe(PG_PG13 | NsfwLevel.R);
    expect(r.nsfwLevel).toBe(NsfwLevel.R);
  });
});
