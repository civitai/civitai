import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';

const EXT = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
  workflow: 'txt2img',
} as never;

/**
 * Each text editor registers itself as a `snippets.targets` slice, and the graph bakes
 * that set into the value. It used to do it in `coerce`, which the lib runs for trusted
 * `set()` writes only — so a parse that SUPPLIED a snippets value kept the caller's
 * targets and registered no editors at all. That was the largest single divergence class
 * measured in production, and a parse supplying NOTHING (which goes through `default`)
 * was unaffected, which is why it survived: every obvious test took the default path.
 *
 * So each case below SUPPLIES a value, and the assertion is the registration, not the
 * round-trip.
 */
describe('snippets targets are registered on a SUPPLIED value, not just the default', () => {
  const snippetsOf = (snippets?: unknown) => {
    const input: Record<string, unknown> = {
      workflow: 'txt2img',
      ecosystem: 'SDXL',
      prompt: 'a cat',
    };
    if (snippets) input.snippets = snippets;
    const result = generationHub.parse(input as never, EXT);
    if (!result.success) throw new Error('hub parse failed');
    return (result.data as Record<string, unknown>).snippets as {
      wildcardSetIds: number[];
      mode: string;
      batchCount: number;
      targets: Record<string, unknown[]>;
    };
  };

  // SDXL's txt2img has exactly two text editors, so both slices must be present on
  // every supplied value — including ones that name neither.
  it.each([
    ['nothing supplied — the default path, which already worked', undefined],
    [
      'a value with sets but an empty targets map',
      { wildcardSetIds: [7, 9], mode: 'random', batchCount: 3, targets: {} },
    ],
    [
      'a value naming only one of the two editors',
      { wildcardSetIds: [], mode: 'random', batchCount: 1, targets: { prompt: [] } },
    ],
    ['a partial object with no targets key at all', { wildcardSetIds: [4] }],
  ])('registers both editors: %s', (_label, snippets) => {
    expect(Object.keys(snippetsOf(snippets)).sort()).toContain('targets');
    expect(Object.keys(snippetsOf(snippets).targets).sort()).toEqual(['negativePrompt', 'prompt']);
  });

  it('keeps the caller’s sets, mode and batch count while adding the targets', () => {
    expect(snippetsOf({ wildcardSetIds: [7, 9], mode: 'batch', batchCount: 3 })).toMatchObject({
      wildcardSetIds: [7, 9],
      mode: 'batch',
      batchCount: 3,
    });
  });

  it('keeps a reference the caller already placed on an editor', () => {
    const targets = snippetsOf({
      wildcardSetIds: [],
      mode: 'random',
      batchCount: 1,
      targets: { prompt: [{ category: 'x', selections: [] }] },
    }).targets;
    expect(targets.prompt).toEqual([{ category: 'x', selections: [] }]);
    expect(targets.negativePrompt).toEqual([]);
  });

  // A target for an editor this graph does not have is left alone rather than pruned —
  // pruning would discard a sibling workflow's placement on a shared draft.
  it('leaves a target for an unknown editor in place', () => {
    expect(
      Object.keys(
        snippetsOf({
          wildcardSetIds: [],
          mode: 'random',
          batchCount: 1,
          targets: { prompt: [], someGoneEditor: [] },
        }).targets
      ).sort()
    ).toEqual(['negativePrompt', 'prompt', 'someGoneEditor']);
  });
});
