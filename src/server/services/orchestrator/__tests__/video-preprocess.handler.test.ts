import { describe, expect, it } from 'vitest';
import { createVideoPreprocessStep } from '../ecosystems/video-preprocess.handler';

const VIDEO_URL = 'https://example.test/source.mp4';

const data = (overrides: Record<string, unknown> = {}) => ({
  video: { url: VIDEO_URL },
  preprocessKind: 'canny',
  ...overrides,
});

describe('createVideoPreprocessStep', () => {
  it('emits a preprocessVideo step carrying the source video and kind', () => {
    const step = createVideoPreprocessStep(data());

    expect(step).toMatchObject({
      $type: 'preprocessVideo',
      input: { kind: 'canny', video: VIDEO_URL },
    });
  });

  // The control map IS this workflow's deliverable — suppressing it hands the
  // user a completed job with nothing to download.
  it('does NOT suppress the output', () => {
    const step = createVideoPreprocessStep(data({ preprocessKind: 'dwpose' }));

    expect(
      (step.metadata as { suppressOutput?: boolean } | null | undefined)?.suppressOutput
    ).toBeFalsy();
  });

  it('forwards the resolution and flattens the kind-specific params', () => {
    const step = createVideoPreprocessStep(
      data({ preprocessResolution: 1024, kindParams: { lowThreshold: 50, highThreshold: 150 } })
    );

    expect(step.input).toMatchObject({
      kind: 'canny',
      resolution: 1024,
      lowThreshold: 50,
      highThreshold: 150,
    });
  });

  it('omits an absent resolution rather than sending null', () => {
    const step = createVideoPreprocessStep(data());

    expect('resolution' in (step.input as Record<string, unknown>)).toBe(false);
  });

  // kindParams is a free-form record straight off the wire. Spread last it would
  // win, letting a caller run an arbitrary resolution or an image-only kind.
  it('cannot override the validated kind or the clamped resolution', () => {
    const step = createVideoPreprocessStep(
      data({
        preprocessResolution: 512,
        kindParams: { resolution: 8192, kind: 'openpose', video: 'https://evil/x.mp4' },
      })
    );

    expect(step.input).toMatchObject({
      kind: 'canny',
      resolution: 512,
      video: VIDEO_URL,
    });
  });

  it.each([
    ['a missing video', { video: undefined }],
    ['an empty url', { video: { url: '' } }],
    ['a null video', { video: null }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => createVideoPreprocessStep(data(overrides) as never)).toThrow();
  });
});
