import { describe, it, expect } from 'vitest';
import { getMyChallengeCta, getMyChallengeBadge } from './myChallengeCard.utils';

describe('getMyChallengeCta', () => {
  it('won => View results (white)', () =>
    expect(getMyChallengeCta('won', false)).toEqual({
      kind: 'results',
      label: 'View results',
      filled: 'white',
    }));
  it('judging => View entry (white)', () =>
    expect(getMyChallengeCta('judging', false)).toEqual({
      kind: 'entry',
      label: 'View entry',
      filled: 'white',
    }));
  it('entered + live => Add another entry (blue)', () =>
    expect(getMyChallengeCta('entered', true)).toEqual({
      kind: 'add',
      label: 'Add another entry',
      filled: 'blue',
    }));
  it('entered + not live => View results (white)', () =>
    expect(getMyChallengeCta('entered', false)).toEqual({
      kind: 'results',
      label: 'View results',
      filled: 'white',
    }));
});

describe('getMyChallengeBadge', () => {
  it('placed => "#2 Placed" dark medal', () =>
    expect(getMyChallengeBadge('placed', 2)).toEqual({
      label: '#2 Placed',
      color: 'dark',
      icon: 'medal',
    }));
  it('won => "Won" gold trophy', () =>
    expect(getMyChallengeBadge('won', 1)).toEqual({
      label: 'Won',
      color: 'gold',
      icon: 'trophy',
    }));
});
