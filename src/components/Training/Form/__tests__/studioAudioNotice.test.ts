import { describe, expect, it } from 'vitest';
import {
  disabledMediaTooltip,
  isStudioToggleAvailable,
  showStudioAudioNotice,
} from '~/components/Training/Form/studioAudioNotice';

const show = (audioTraining: boolean, mediaType?: 'image' | 'video' | 'audio', toggle = true) =>
  showStudioAudioNotice({
    features: { audioTraining },
    studioToggleAvailable: toggle,
    mediaType,
  });

describe('showStudioAudioNotice', () => {
  it('shows for every media type when old-trainer audio is off', () => {
    expect(show(false, 'image')).toBe(true);
    expect(show(false, 'video')).toBe(true);
    expect(show(false, undefined)).toBe(true);
  });

  it('shows when old-trainer audio is on and audio is selected', () => {
    expect(show(true, 'audio')).toBe(true);
  });

  it('stays hidden when old-trainer audio is on and a non-audio media is selected', () => {
    expect(show(true, 'image')).toBe(false);
    expect(show(true, 'video')).toBe(false);
  });

  it('stays hidden when the user has no Training Studio toggle to turn on', () => {
    expect(show(false, 'image', false)).toBe(false);
    expect(show(true, 'audio', false)).toBe(false);
  });
});

describe('isStudioToggleAvailable', () => {
  it('is true when the key is present, even toggled off', () => {
    expect(isStudioToggleAvailable({ trainingStudioUi: false })).toBe(true);
  });

  it('is false when the key is withheld or flags have not loaded', () => {
    expect(isStudioToggleAvailable({ audioTraining: true })).toBe(false);
    expect(isStudioToggleAvailable(undefined)).toBe(false);
  });
});

describe('disabledMediaTooltip', () => {
  it('points disabled audio at the Training Studio', () => {
    expect(disabledMediaTooltip('audio')).toMatch(/Training Studio/);
  });

  it('does not point disabled video at the Training Studio', () => {
    expect(disabledMediaTooltip('video')).not.toMatch(/Training Studio/);
  });
});
