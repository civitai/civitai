import { describe, expect, it } from 'vitest';
import {
  getTrainingSettingOverride,
  type TrainingSettingsType,
} from '~/components/Training/Form/TrainingParams';

const setting: TrainingSettingsType = {
  name: 'networkAlpha',
  label: 'Network Alpha',
  hint: null,
  type: 'int',
  default: 16,
  min: 1,
  max: 128,
  step: 1,
  overrides: {
    sdxl: { all: { max: 256, hint: 'all' }, 'ai-toolkit': { default: 32, hint: 'ai-toolkit' } },
  },
};

describe('getTrainingSettingOverride', () => {
  it("applies an engine entry on a base that also has an 'all' entry, the engine winning per field", () => {
    expect(getTrainingSettingOverride(setting, 'sdxl', 'ai-toolkit')).toEqual({
      max: 256,
      default: 32,
      hint: 'ai-toolkit',
    });
  });

  it("falls back to the 'all' entry for an engine without its own", () => {
    expect(getTrainingSettingOverride(setting, 'sdxl', 'kohya')).toEqual({ max: 256, hint: 'all' });
  });

  it('is empty for a base without overrides', () => {
    expect(getTrainingSettingOverride(setting, 'pony', 'kohya')).toEqual({});
  });
});
