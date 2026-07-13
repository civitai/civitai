import { describe, it, expect } from 'vitest';
import { nsfwBrowsingLevelsFlag, sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import {
  deriveDomainCurrency,
  isNonSfwForGreen,
  isChallengeHiddenByDomainCurrency,
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
