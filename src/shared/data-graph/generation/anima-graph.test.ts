import { describe, expect, it } from 'vitest';
import { ecosystemByKey, getCompatibleBaseModels } from '~/shared/constants/basemodel.constants';

describe('Anima resource compatibility', () => {
  const anima = ecosystemByKey.get('Anima')!;

  it('offers Anima as a base model for LoCon resources', () => {
    const { full } = getCompatibleBaseModels(anima.id, 'LoCon');
    expect(full.map((m) => m.name)).toContain('Anima');
  });

  // Adopting the shared `fullAddonTypes` preset would enable this too, for the one published
  // Anima Textual Inversion that exists. Nobody asked for it; LoCon was approved on its own.
  it('does not offer Anima for Textual Inversion', () => {
    const { full, partial } = getCompatibleBaseModels(anima.id, 'TextualInversion');
    expect([...full, ...partial].map((m) => m.name)).not.toContain('Anima');
  });
});
