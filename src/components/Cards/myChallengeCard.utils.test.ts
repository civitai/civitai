import { describe, it, test, expect } from 'vitest';
import {
  getMyChallengeCta,
  getMyChallengeBadge,
  getMyChallengeCtaHref,
} from './myChallengeCard.utils';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

describe('getMyChallengeCta', () => {
  it('won => View results (white)', () =>
    expect(getMyChallengeCta('won', false, ChallengeStatus.Completed)).toEqual({
      kind: 'results',
      label: 'View results',
      filled: 'white',
    }));
  it('judging => View entry (white)', () =>
    expect(getMyChallengeCta('judging', false, ChallengeStatus.Completed)).toEqual({
      kind: 'entry',
      label: 'View entry',
      filled: 'white',
    }));
  it('entered + live => Add another entry (blue)', () =>
    expect(getMyChallengeCta('entered', true, ChallengeStatus.Active)).toEqual({
      kind: 'add',
      label: 'Add another entry',
      filled: 'blue',
    }));
  it('entered + not live => View results (white)', () =>
    expect(getMyChallengeCta('entered', false, ChallengeStatus.Completed)).toEqual({
      kind: 'results',
      label: 'View results',
      filled: 'white',
    }));
});

describe('getMyChallengeCtaHref', () => {
  const challenge = { id: 42, title: 'Crystal Caverns' };

  it('manage skips the deep link and goes to the edit page', () =>
    expect(getMyChallengeCtaHref('manage', challenge)).toBe('/challenges/42/edit'));
  it('results anchors to the entries gallery', () =>
    expect(getMyChallengeCtaHref('results', challenge)).toBe(
      '/challenges/42/crystal-caverns#entries'
    ));
  it('entry anchors to the entries gallery filtered to the viewer', () =>
    expect(getMyChallengeCtaHref('entry', challenge)).toBe(
      '/challenges/42/crystal-caverns?mine=1#entries'
    ));
  it('add opens the submit modal on arrival', () =>
    expect(getMyChallengeCtaHref('add', challenge)).toBe(
      '/challenges/42/crystal-caverns?submit=1#entries'
    ));
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

describe('hosting', () => {
  test('badge is a grape crown', () => {
    expect(getMyChallengeBadge('hosting', null)).toEqual({
      label: 'Hosting',
      color: 'grape',
      icon: 'crown',
    });
  });

  test('a scheduled hosted challenge offers Manage', () => {
    expect(getMyChallengeCta('hosting', false, ChallengeStatus.Scheduled)).toEqual({
      kind: 'manage',
      label: 'Manage',
      filled: 'white',
    });
  });

  test('a live hosted challenge offers View entries', () => {
    expect(getMyChallengeCta('hosting', true, ChallengeStatus.Active)).toEqual({
      kind: 'results',
      label: 'View entries',
      filled: 'white',
    });
  });

  test('a hosted challenge being judged offers View entries, not View results', () => {
    expect(getMyChallengeCta('hosting', false, ChallengeStatus.Completing)).toEqual({
      kind: 'results',
      label: 'View entries',
      filled: 'white',
    });
  });

  test('a finished hosted challenge offers View results', () => {
    expect(getMyChallengeCta('hosting', false, ChallengeStatus.Completed)).toEqual({
      kind: 'results',
      label: 'View results',
      filled: 'white',
    });
  });
});
