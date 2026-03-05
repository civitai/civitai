import { describe, it, expect } from 'vitest';
import {
  isStepRef,
  buildStepRef,
  assignStepNames,
  getOutputRefPath,
  buildStepOutputRef,
} from '../step-ref';

// =============================================================================
// isStepRef
// =============================================================================

describe('isStepRef', () => {
  it('detects a valid step reference', () => {
    expect(isStepRef({ $ref: '$0', path: 'output.images[0].url' })).toBe(true);
  });

  it('detects references to named steps', () => {
    expect(isStepRef({ $ref: 'generate', path: 'output.images[0].url' })).toBe(true);
  });

  it('detects $arguments references', () => {
    expect(isStepRef({ $ref: '$arguments', path: 'mediaUrl' })).toBe(true);
  });

  it('rejects plain strings (URLs)', () => {
    expect(isStepRef('https://example.com/image.png')).toBe(false);
  });

  it('rejects null', () => {
    expect(isStepRef(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isStepRef(undefined)).toBe(false);
  });

  it('rejects numbers', () => {
    expect(isStepRef(42)).toBe(false);
  });

  it('rejects objects without $ref', () => {
    expect(isStepRef({ path: 'output.images[0].url' })).toBe(false);
  });

  it('rejects objects without path', () => {
    expect(isStepRef({ $ref: '$0' })).toBe(false);
  });

  it('rejects objects where $ref is not a string', () => {
    expect(isStepRef({ $ref: 0, path: 'output.images[0].url' })).toBe(false);
  });

  it('rejects objects where path is not a string', () => {
    expect(isStepRef({ $ref: '$0', path: 123 })).toBe(false);
  });

  it('accepts objects with extra properties (tolerant)', () => {
    expect(isStepRef({ $ref: '$0', path: 'output.images[0].url', extra: true })).toBe(true);
  });
});

// =============================================================================
// buildStepRef
// =============================================================================

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

  it('produces refs that pass isStepRef', () => {
    const ref = buildStepRef(0, 'output.images[0].url');
    expect(isStepRef(ref)).toBe(true);
  });
});

// =============================================================================
// assignStepNames
// =============================================================================

describe('assignStepNames', () => {
  it('assigns sequential names to steps', () => {
    const steps = [
      { $type: 'textToImage', input: { prompt: 'a cat' } },
      { $type: 'comfy', input: { comfyWorkflow: {} } },
    ];

    const named = assignStepNames(steps);

    expect(named[0].name).toBe('$0');
    expect(named[1].name).toBe('$1');
  });

  it('preserves all original step properties', () => {
    const steps = [
      {
        $type: 'textToImage',
        input: { prompt: 'a cat', model: 'urn:air:sd15' },
        metadata: { params: { prompt: 'a cat' } },
      },
    ];

    const named = assignStepNames(steps);

    expect(named[0].$type).toBe('textToImage');
    expect(named[0].input).toEqual({ prompt: 'a cat', model: 'urn:air:sd15' });
    expect(named[0].metadata).toEqual({ params: { prompt: 'a cat' } });
  });

  it('does not mutate original steps', () => {
    const steps = [{ $type: 'textToImage', input: {} }];
    const named = assignStepNames(steps);

    expect(named[0]).not.toBe(steps[0]);
    expect((steps[0] as any).name).toBeUndefined();
  });

  it('overwrites existing names', () => {
    const steps = [
      { $type: 'textToImage', name: 'old-name', input: {} },
    ];

    const named = assignStepNames(steps);

    expect(named[0].name).toBe('$0');
  });

  it('handles empty array', () => {
    const named = assignStepNames([]);
    expect(named).toEqual([]);
  });

  it('handles single step', () => {
    const named = assignStepNames([{ $type: 'textToImage', input: {} }]);
    expect(named).toHaveLength(1);
    expect(named[0].name).toBe('$0');
  });
});

// =============================================================================
// getOutputRefPath
// =============================================================================

describe('getOutputRefPath', () => {
  it('returns image path for image output type', () => {
    expect(getOutputRefPath('image')).toBe('output.images[0].url');
  });

  it('returns video path for video output type', () => {
    expect(getOutputRefPath('video')).toBe('output.video.url');
  });

  it('supports custom image index', () => {
    expect(getOutputRefPath('image', 2)).toBe('output.images[2].url');
  });

  it('ignores image index for video output', () => {
    expect(getOutputRefPath('video', 5)).toBe('output.video.url');
  });
});

// =============================================================================
// buildStepOutputRef
// =============================================================================

describe('buildStepOutputRef', () => {
  it('builds ref for an image-producing step', () => {
    // txt2img at step 0 produces images
    const ref = buildStepOutputRef(0, 'image');

    expect(ref).toEqual({ $ref: '$0', path: 'output.images[0].url' });
    expect(isStepRef(ref)).toBe(true);
  });

  it('builds ref for a video-producing step', () => {
    // videoGen at step 0 produces video
    const ref = buildStepOutputRef(0, 'video');

    expect(ref).toEqual({ $ref: '$0', path: 'output.video.url' });
  });

  it('builds ref for a specific image index', () => {
    const ref = buildStepOutputRef(0, 'image', 3);

    expect(ref).toEqual({ $ref: '$0', path: 'output.images[3].url' });
  });

  it('builds ref for a later step', () => {
    // upscale at step 1 produces images
    const ref = buildStepOutputRef(1, 'image');

    expect(ref).toEqual({ $ref: '$1', path: 'output.images[0].url' });
  });
});

// =============================================================================
// Integration: chaining derivation
// =============================================================================

describe('integration: chaining derivation from output type', () => {
  /**
   * Simulates what the service would do: given a preceding step's output type
   * (derived from its workflow config's `category`), build the $ref for the
   * follow-up step's image/video input.
   */
  it('txt2img (image output) → img2img:hires-fix knows to ref images', () => {
    // txt2img config has category: 'image' → getOutputTypeForWorkflow returns 'image'
    const precedingOutputType = 'image' as const;
    const ref = buildStepOutputRef(0, precedingOutputType);

    expect(ref.path).toBe('output.images[0].url');
  });

  it('videoGen (video output) → vid2vid:upscale knows to ref video', () => {
    const precedingOutputType = 'video' as const;
    const ref = buildStepOutputRef(0, precedingOutputType);

    expect(ref.path).toBe('output.video.url');
  });

  it('full chain: txt2img → hires-fix → face-fix with derived refs', () => {
    // Step 0: txt2img — outputs images
    // Step 1: hires-fix — takes image input from step 0, outputs images
    // Step 2: face-fix — takes image input from step 1, outputs images

    const step0Output = 'image' as const;
    const step1Output = 'image' as const;

    const step1ImageRef = buildStepOutputRef(0, step0Output);
    const step2ImageRef = buildStepOutputRef(1, step1Output);

    const steps = assignStepNames([
      {
        $type: 'textToImage',
        input: { prompt: 'a portrait', model: 'urn:air:sd15' },
        metadata: {},
      },
      {
        $type: 'comfy',
        input: { comfyWorkflow: { image: step1ImageRef, hiresFixStrength: 0.6 } },
        metadata: { source: { params: { prompt: 'a portrait' }, resources: [] } },
      },
      {
        $type: 'comfy',
        input: { comfyWorkflow: { image: step2ImageRef, faceFixStrength: 0.7 } },
        metadata: { source: { params: { prompt: 'a portrait' }, resources: [] } },
      },
    ]);

    // Step 1 references step 0's image output
    expect((steps[1].input as any).comfyWorkflow.image).toEqual({
      $ref: '$0',
      path: 'output.images[0].url',
    });

    // Step 2 references step 1's image output
    expect((steps[2].input as any).comfyWorkflow.image).toEqual({
      $ref: '$1',
      path: 'output.images[0].url',
    });
  });

  it('cross-media chain: txt2img → img2vid with derived refs', () => {
    // Step 0: txt2img — outputs images
    // Step 1: img2vid — takes image input from step 0, outputs video

    const step0Output = 'image' as const;
    const ref = buildStepOutputRef(0, step0Output);

    const steps = assignStepNames([
      {
        $type: 'textToImage',
        input: { prompt: 'a dancing cat' },
        metadata: {},
      },
      {
        $type: 'videoGen',
        input: { image: ref, prompt: 'animate this' },
        metadata: { source: { params: { prompt: 'a dancing cat' }, resources: [] } },
      },
    ]);

    // img2vid references txt2img's image output
    expect((steps[1].input as any).image).toEqual({
      $ref: '$0',
      path: 'output.images[0].url',
    });
  });
});

// =============================================================================
// Integration: step naming + references
// =============================================================================

describe('integration: chained workflow with $ref', () => {
  it('produces named steps where later steps reference earlier ones', () => {
    // Step 0: text-to-image generation
    const step0 = {
      $type: 'textToImage' as const,
      input: { prompt: 'a portrait', model: 'urn:air:sd15', seed: 42 },
      metadata: {},
    };

    // Step 1: face-fix referencing step 0's output
    const faceFixImageRef = buildStepRef(0, 'output.images[0].url');
    const step1 = {
      $type: 'comfy' as const,
      input: {
        comfyWorkflow: {
          image: faceFixImageRef,
          faceFixStrength: 0.7,
        },
      },
      metadata: {
        source: {
          params: { prompt: 'a portrait', seed: 42 },
          resources: [],
        },
      },
    };

    // Assign names
    const named = assignStepNames([step0, step1]);

    // Verify step 0 is named '$0'
    expect(named[0].name).toBe('$0');

    // Verify step 1 references step 0 via $ref
    expect(named[1].name).toBe('$1');
    const imageInput = (named[1].input as any).comfyWorkflow.image;
    expect(isStepRef(imageInput)).toBe(true);
    expect(imageInput.$ref).toBe('$0');
    expect(imageInput.path).toBe('output.images[0].url');
  });

  it('supports three-step chain: txt2img → upscale → face-fix', () => {
    const steps = [
      {
        $type: 'textToImage',
        input: { prompt: 'a portrait' },
        metadata: {},
      },
      {
        $type: 'comfy',
        input: {
          comfyWorkflow: { image: buildStepRef(0, 'output.images[0].url') },
        },
        metadata: { source: { params: { prompt: 'a portrait' }, resources: [] } },
      },
      {
        $type: 'comfy',
        input: {
          comfyWorkflow: { image: buildStepRef(1, 'output.images[0].url') },
        },
        metadata: { source: { params: { prompt: 'a portrait' }, resources: [] } },
      },
    ];

    const named = assignStepNames(steps);

    expect(named[0].name).toBe('$0');
    expect(named[1].name).toBe('$1');
    expect(named[2].name).toBe('$2');

    // Step 1 refs step 0
    expect((named[1].input as any).comfyWorkflow.image.$ref).toBe('$0');
    // Step 2 refs step 1
    expect((named[2].input as any).comfyWorkflow.image.$ref).toBe('$1');
  });
});
