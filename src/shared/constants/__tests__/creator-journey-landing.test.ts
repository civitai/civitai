import { describe, expect, it } from 'vitest';
import { milestoneLandingHref } from '~/shared/constants/creator-journey.constants';

const landing = (over: Partial<Parameters<typeof milestoneLandingHref>[0]> = {}) =>
  milestoneLandingHref({
    username: 'JustMaier',
    milestone: 'supernova',
    shareable: true,
    journeyOn: true,
    ...over,
  });

describe('where a shared tier link lands', () => {
  it('sends a shareable tier to the Achievements tab, naming the tier', () => {
    expect(landing()).toBe('/user/JustMaier/achievements?milestone=supernova');
  });

  it('sends a shareable achievement there too, naming it by its key', () => {
    expect(landing({ milestone: 'reach:downloads-10000' })).toBe(
      '/user/JustMaier/achievements?milestone=reach:downloads-10000'
    );
  });

  it.each([
    ['not shareable', { shareable: false }],
    ['not yet known to be shareable', { shareable: undefined }],
    ['the journey is off', { journeyOn: false }],
    ['no tier', { milestone: null }],
  ])('stays on the profile when %s', (_, over) => {
    expect(landing(over)).toBeNull();
  });

  it('encodes the username', () => {
    expect(landing({ username: 'a b' })).toBe('/user/a%20b/achievements?milestone=supernova');
  });
});
