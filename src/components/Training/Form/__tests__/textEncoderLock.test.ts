import { describe, expect, it } from 'vitest';
import { TEXT_ENCODER_LOCKED_BASES } from '@civitai/shared/training-text-encoder';
import { trainingSettings } from '~/components/Training/Form/TrainingParams';

const teSetting = trainingSettings.find((s) => s.name === 'textEncoderLR')!;
const overrides = (teSetting.overrides ?? {}) as Record<string, { all?: Record<string, unknown> }>;

describe('in-app trainer text encoder lock', () => {
  it('locks exactly the shared list at 0, so the Training Studio locks the same bases', () => {
    const locked = Object.keys(overrides).filter((base) => overrides[base]?.all?.disabled === true);
    expect(locked.sort()).toEqual([...TEXT_ENCODER_LOCKED_BASES].sort());
    for (const base of TEXT_ENCODER_LOCKED_BASES)
      expect(overrides[base]).toEqual({ all: { disabled: true, default: 0, max: 0 } });
  });
});
