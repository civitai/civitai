import { describe, expect, it } from 'vitest';
import { getStoredOutputScope, workflowConfigs } from './workflows';

// The ecosystem is persisted at `generation-graph.output.<scope>`, where the
// scope is the `output` graph node — i.e. the workflow's category. Deriving it
// by string-matching the key instead read the IMAGE scope for txt2music, so the
// stored image ecosystem never matched the resolved audio one and
// GenerationFormProvider fired the compatibility modal on every reload.
//
// Reverting to the `.includes('2vid') ? 'video' : 'image'` heuristic fails the
// audio and 3D cases here by name.
describe('getStoredOutputScope', () => {
  it.each(Object.keys(workflowConfigs))('matches the workflow category for %s', (key) => {
    expect(getStoredOutputScope(key)).toBe(
      workflowConfigs[key as keyof typeof workflowConfigs].category
    );
  });

  // Named rather than only covered by the sweep above, because these are the two
  // categories the old heuristic could not express at all.
  it('scopes txt2music to audio, not image', () => {
    expect(getStoredOutputScope('txt2music')).toBe('audio');
  });

  it('scopes a 3D workflow to model3d, not image', () => {
    expect(getStoredOutputScope('txt2model3d')).toBe('model3d');
  });

  // The whole reason the heuristic existed: a key that no longer exists has no
  // category to read, and getOutputTypeForWorkflow would answer 'image' for a
  // retired video workflow.
  it('still guesses video for a retired workflow key', () => {
    expect(workflowConfigs).not.toHaveProperty('txt2vid:retired');
    expect(getStoredOutputScope('txt2vid:retired')).toBe('video');
  });

  it('falls back to image for an unrecognisable key', () => {
    expect(getStoredOutputScope('something-else-entirely')).toBe('image');
  });
});
