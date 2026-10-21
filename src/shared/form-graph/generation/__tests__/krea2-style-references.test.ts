import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { krea2VersionIds } from '~/shared/form-graph/generation/image/krea2.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const IMAGE = { url: 'https://example.com/a.png', width: 1024, height: 1024 };

const parse = (styleReferences?: unknown) =>
  generationHub.parse(
    {
      workflow: 'txt2img',
      ecosystem: 'Krea2',
      model: { id: krea2VersionIds.medium },
      prompt: 'a cat',
      ...(styleReferences === undefined ? {} : { styleReferences }),
    },
    EXT
  );

const refsOf = (result: ReturnType<typeof parse>) =>
  result.success ? (result.data as { styleReferences?: unknown }).styleReferences : result.errors;

describe('Krea 2 style references at the parse boundary', () => {
  it('a submission without any parses to an empty list', () => {
    expect(refsOf(parse())).toEqual([]);
  });

  it('fills in the default strength, accepts a bare url and drops an entry with no image', () => {
    expect(
      refsOf(parse([{ image: IMAGE }, { image: IMAGE.url, strength: 0.8 }, { strength: 0.3 }]))
    ).toEqual([
      { image: IMAGE, strength: 0.5 },
      { image: { url: IMAGE.url }, strength: 0.8 },
    ]);
  });

  it('a strength outside 0..1 is not sent', () => {
    expect(refsOf(parse([{ image: IMAGE, strength: 1.2 }]))).toEqual([]);
  });

  it('more than ten references are not sent', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      image: { url: `https://example.com/${i}.png` },
    }));

    expect(refsOf(parse(eleven))).toEqual([]);
  });
});
