import { describe, it, expect } from 'vitest';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { deriveMyChallengeResult } from './challenge-participation.util';

describe('deriveMyChallengeResult', () => {
  it('completed + place 1 => won', () => {
    expect(deriveMyChallengeResult({ status: ChallengeStatus.Completed, myPlace: 1 }))
      .toEqual({ result: 'won', isLive: false });
  });
  it('completed + place 2 => placed', () => {
    expect(deriveMyChallengeResult({ status: ChallengeStatus.Completed, myPlace: 2 }))
      .toEqual({ result: 'placed', isLive: false });
  });
  it('completed + no placement => entered', () => {
    expect(deriveMyChallengeResult({ status: ChallengeStatus.Completed, myPlace: null }))
      .toEqual({ result: 'entered', isLive: false });
  });
  it('completing => judging', () => {
    expect(deriveMyChallengeResult({ status: ChallengeStatus.Completing, myPlace: null }))
      .toEqual({ result: 'judging', isLive: false });
  });
  it('active => entered + live', () => {
    expect(deriveMyChallengeResult({ status: ChallengeStatus.Active, myPlace: null }))
      .toEqual({ result: 'entered', isLive: true });
  });
});
