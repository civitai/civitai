import { describe, it, expect } from 'vitest';
import { buildStepRef } from '../step-ref';

describe('buildStepRef', () => {
  it('builds a reference to step 0 image output', () => {
    const ref = buildStepRef(0, 'output.images[0].url');

    expect(ref).toEqual({ $ref: '$0', path: 'output.images[0].url' });
  });

  it('builds a reference to step 1 video output', () => {
    const ref = buildStepRef(1, 'output.video.url');

    expect(ref).toEqual({ $ref: '$1', path: 'output.video.url' });
  });

  it('builds a reference to a specific image index', () => {
    const ref = buildStepRef(0, 'output.images[2].url');

    expect(ref).toEqual({ $ref: '$0', path: 'output.images[2].url' });
  });
});
