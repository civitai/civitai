import { describe, expect, it } from 'vitest';
import { scopeRecommendedSettings } from '~/components/Resource/Forms/model-version-settings';

const range = { min: 4, max: 8, default: 8 };
const turbo = { steps: range, cfgScale: { min: 1, max: 1, default: 1 } };

describe('scopeRecommendedSettings', () => {
  // A LoRA moved to a base model outside an opted-in ecosystem keeps its old block in the form;
  // sent along, the server refuses every later save of that version.
  it('drops a turbo block the editor no longer renders', () => {
    const scoped = scopeRecommendedSettings(
      { strength: 1, turbo },
      { turboSection: false, turboLoraPicker: false }
    );
    expect(scoped).toEqual({ strength: 1, generation: undefined, turbo: undefined });
  });

  it('keeps a turbo block the editor rendered', () => {
    const scoped = scopeRecommendedSettings(
      { turbo },
      { turboSection: true, turboLoraPicker: false }
    );
    expect(scoped?.turbo).toEqual(turbo);
  });

  it('keeps only the turbo LoRA of a checkpoint block, and only while the picker renders', () => {
    const settings = { generation: { turboLora: { id: 3413516 } } };
    expect(
      scopeRecommendedSettings(settings, { turboSection: false, turboLoraPicker: true })?.generation
    ).toEqual({ turboLora: { id: 3413516 } });
    expect(
      scopeRecommendedSettings(settings, { turboSection: false, turboLoraPicker: false })
        ?.generation
    ).toBeUndefined();
  });

  it('passes an absent settings object through', () => {
    expect(
      scopeRecommendedSettings(null, { turboSection: true, turboLoraPicker: true })
    ).toBeNull();
  });
});
