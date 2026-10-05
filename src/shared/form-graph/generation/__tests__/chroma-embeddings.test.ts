import { describe, expect, it } from 'vitest';
import { isBaseModelGenerationSupported } from '@civitai/shared/basemodel.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { generationHub } from '../hub.graph';

const EXT = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
  workflow: 'txt2img',
} as never;

describe('Chroma does not accept embeddings', () => {
  it('refuses a TextualInversion but keeps every other addon type', () => {
    expect(isBaseModelGenerationSupported('Chroma', ModelType.TextualInversion)).toBe(false);
    for (const t of [
      ModelType.Checkpoint,
      ModelType.LORA,
      ModelType.DoRA,
      ModelType.LoCon,
      ModelType.VAE,
    ]) {
      expect(isBaseModelGenerationSupported('Chroma', t), t).toBe(true);
    }
  });

  // 🔴 THE HALF THAT MATTERS. Narrowing the constants alone once left a selected TI in the
  // form as a value the output refused and nothing could clear. `resourcesDef`'s `correct`
  // is what makes it recoverable — it drops the resource and says why, rather than wedging.
  it('corrects a stored Chroma TextualInversion out of the form instead of wedging', () => {
    const result = generationHub.parse(
      {
        workflow: 'txt2img',
        ecosystem: 'Chroma',
        prompt: 'a cat',
        resources: [
          { id: 111, baseModel: 'Chroma', model: { type: 'TextualInversion' }, strength: 1 },
          { id: 222, baseModel: 'Chroma', model: { type: 'LORA' }, strength: 0.8 },
        ],
      } as never,
      EXT
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const resources = (result.data as { resources?: { id: number }[] }).resources ?? [];
    expect(resources.map((r) => r.id)).toEqual([222]);
    expect(result.notes).toContainEqual(
      expect.objectContaining({ key: 'resources', kind: 'ecosystem_incompatible' })
    );
  });
});
