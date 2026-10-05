import { describe, expect, it } from 'vitest';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import { generationHub } from '../hub.graph';

const EXT = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
  workflow: 'txt2img',
} as never;

/**
 * v1 registers each text editor as a `snippets.targets` slice through an effect; the port bakes
 * the same set into the value instead. It did that in `coerce`, which the lib runs for trusted
 * `set()` writes only — so a parse that SUPPLIED a snippets value kept the caller's targets and
 * registered no editors, while v1 added them. It was the largest single shadow-parse divergence
 * class in production, and a bare parse (which uses `default`) matched, which is why it survived.
 */
describe('snippets targets are registered on a SUPPLIED value, not just the default', () => {
  const parseBoth = (snippets?: unknown) => {
    const input: Record<string, unknown> = {
      workflow: 'txt2img',
      ecosystem: 'SDXL',
      prompt: 'a cat',
    };
    if (snippets) input.snippets = snippets;
    const v1 = generationGraph.safeParse(input as never, EXT);
    const hub = generationHub.parse(input as never, EXT);
    if (!hub.success) throw new Error('hub parse failed');
    return {
      v1: (v1.data as Record<string, unknown>)?.snippets,
      hub: (hub.data as Record<string, unknown>).snippets,
    };
  };

  it.each([
    ['nothing supplied — the default path, which already matched', undefined],
    [
      'a value with sets but no targets',
      { wildcardSetIds: [7, 9], mode: 'random', batchCount: 3, targets: {} },
    ],
    [
      'a value carrying a target for an editor this graph does not have',
      {
        wildcardSetIds: [],
        mode: 'random',
        batchCount: 1,
        targets: { prompt: [], someGoneEditor: [] },
      },
    ],
    [
      'a target holding a real reference',
      {
        wildcardSetIds: [],
        mode: 'random',
        batchCount: 1,
        targets: { prompt: [{ category: 'x', setId: 7 }] },
      },
    ],
    ['a partial object', { wildcardSetIds: [4] }],
  ])('agrees with v1: %s', (_label, snippets) => {
    const { v1, hub } = parseBoth(snippets);
    expect(hub).toEqual(v1);
  });

  it('registers both editors of a graph that has a negative prompt', () => {
    const { hub } = parseBoth({ wildcardSetIds: [4] });
    expect(Object.keys((hub as { targets: object }).targets).sort()).toEqual([
      'negativePrompt',
      'prompt',
    ]);
  });
});
