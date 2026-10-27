import { describe, expect, it } from 'vitest';
import { howToUseModelHref } from '~/components/Model/HowToUseModel/HowToUseModel';
import { ModelType } from '~/shared/utils/prisma/enums';

const GUIDE = 'https://education.civitai.com/civitais-guide-to-resource-types/';

describe('howToUseModelHref', () => {
  // A tester followed the LoRA and Checkpoint icons to the retired GitHub wiki (10/27).
  it.each([
    [ModelType.LORA, `${GUIDE}#Loras`],
    [ModelType.Checkpoint, `${GUIDE}#models`],
    [ModelType.TextualInversion, `${GUIDE}#Embeddings`],
  ])('links %s to its section of the Education guide', (type, href) => {
    expect(howToUseModelHref(type)).toBe(href);
  });

  it('never links to the GitHub wiki', () => {
    for (const type of Object.values(ModelType)) {
      expect(howToUseModelHref(type) ?? '').not.toContain('github.com');
    }
  });

  it('shows no link for a type the guide does not cover', () => {
    expect(howToUseModelHref(ModelType.Other)).toBeNull();
  });
});
