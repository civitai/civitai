import { describe, expect, it } from 'vitest';
import { ModelType } from '~/shared/utils/prisma/enums';
import {
  BM,
  ECO,
  SELF_HOSTED_ECOSYSTEM_KEYS,
  baseModelSelectData,
  getActiveBaseModels,
  getGenerationSupport,
  getTrainingBaseModels,
  isModelSupported,
} from '~/shared/constants/basemodel.constants';

// MiniMax H3 Image is API generation only. Each case is a surface that would let a user
// upload, train or run something under this base model other than the hosted API.
describe('MiniMax H3 Image base model is API generation only', () => {
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

  it('never routes to self-hosted weights', () => {
    expect(SELF_HOSTED_ECOSYSTEM_KEYS).not.toContain('MiniMaxH3Image');
  });
});
