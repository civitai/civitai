import { describe, expect, it } from 'vitest';
import { withImageMetadata } from '~/server/services/orchestrator/step-image-metadata';

describe('withImageMetadata', () => {
  it.each(['imageGen', 'comfy'])('tags an %s step', (type) => {
    expect(withImageMetadata({ engine: 'fal', model: 'flux3' }, type, 'meta')).toEqual({
      engine: 'fal',
      model: 'flux3',
      imageMetadata: 'meta',
    });
  });

  // Flux 3 Max's orchestrator input rejects the unknown imageMetadata member.
  it.each(['videoGen', 'soniloAudioGen'])('leaves a %s step untagged', (type) => {
    const input = { engine: 'flux', version: 'v3.0-max', operation: 'textToVideo' };

    expect(withImageMetadata(input, type, 'meta')).toEqual(input);
  });
});
