import { describe, expect, it } from 'vitest';
import { StepData } from '~/shared/orchestrator/workflow-data';
import type { WorkflowData } from '~/shared/orchestrator/workflow-data';

/**
 * `mediaType` falls through to 'image' for any step type it does not name, so a
 * new VIDEO step type that nobody adds here is silently classified as an image.
 * That is invisible in the type system and shows up only as output that fails to
 * render — which is exactly how vid2vid:preprocess first shipped.
 */
const stepOfType = ($type: string) =>
  new StepData(
    { $type, metadata: {}, output: [] } as never,
    {
      metadata: {},
    } as unknown as WorkflowData
  );

describe('StepData.mediaType', () => {
  it.each(['videoGen', 'videoUpscaler', 'videoEnhancement', 'videoInterpolation'])(
    '%s is video',
    ($type) => {
      expect(stepOfType($type).mediaType).toBe('video');
    }
  );

  it('preprocessVideo is video', () => {
    expect(stepOfType('preprocessVideo').mediaType).toBe('video');
  });

  // Its image sibling must NOT be swept along — it belongs to the default.
  it('preprocessImage stays image', () => {
    expect(stepOfType('preprocessImage').mediaType).toBe('image');
  });

  it.each(['aceStepAudio', 'miniMaxMusic3'])('%s is audio', ($type) => {
    expect(stepOfType($type).mediaType).toBe('audio');
  });
});
