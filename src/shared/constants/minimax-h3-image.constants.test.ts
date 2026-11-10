import { describe, expect, it } from 'vitest';
import { ModelType } from '~/shared/utils/prisma/enums';
import {
  BM,
  ECO,
  baseModelSelectData,
  getActiveBaseModels,
  getBaseModelLicense,
  getGenerationSupport,
  getTrainingBaseModels,
  isModelSupported,
} from '~/shared/constants/basemodel.constants';

// MiniMax H3 Image ships for generation only. Uploads, training and LoRAs under this base
// model are a separate, later change; each case is a surface that would open one early.
describe('MiniMax H3 Image base model is generation only', () => {
  const NAME = 'MiniMax H3 Image';

  it('is not offered in the model upload base-model pickers', () => {
    expect(getActiveBaseModels(false).map((m) => m.name)).not.toContain(NAME);
    const options = baseModelSelectData.flatMap((g) => g.items.map((i) => i.value));
    expect(options).not.toContain(NAME);
  });

  it('is not trainable', () => {
    expect(getTrainingBaseModels().map((m) => m.name)).not.toContain(NAME);
    expect(isModelSupported(BM.MiniMaxH3Image, 'training')).toBe(false);
  });

  it('generates from a checkpoint only, and takes no LoRAs, not even H3 video ones', () => {
    expect(isModelSupported(BM.MiniMaxH3Image, 'generation', ModelType.Checkpoint)).toBe(true);
    expect(isModelSupported(BM.MiniMaxH3Image, 'generation', ModelType.LORA)).toBe(false);
    expect(getGenerationSupport(ECO.MiniMaxH3Image, ECO.MiniMaxH3, ModelType.LORA)).toBeNull();
  });

  // Licence section IV.2: the exact string, which the base model's own label is not.
  it('names MiniMax-H3-Image in the generator', () => {
    expect(getBaseModelLicense(BM.MiniMaxH3Image)?.attribution).toBe('MiniMax-H3-Image');
  });
});
