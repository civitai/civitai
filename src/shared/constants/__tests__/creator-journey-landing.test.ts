import { describe, expect, it } from 'vitest';
import {
  milestoneLandingHref,
  milestoneShareHref,
} from '~/shared/constants/creator-journey.constants';

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

  // The share link must stay on the profile: only its server render carries the tier's og:image.
  it('leaves the share link itself on the profile', () => {
    expect(milestoneShareHref('JustMaier', 'supernova')).toBe(
      '/user/JustMaier?milestone=supernova'
    );
  });

  it('stays on the profile when the tier is not shareable, not yet known, or the journey is off', () => {
    expect(landing({ shareable: false })).toBeNull();
    expect(landing({ shareable: undefined })).toBeNull();
    expect(landing({ journeyOn: false })).toBeNull();
    expect(landing({ milestone: null })).toBeNull();
  });

  it('encodes the username', () => {
    expect(landing({ username: 'a b' })).toBe('/user/a%20b/achievements?milestone=supernova');
  });
});
