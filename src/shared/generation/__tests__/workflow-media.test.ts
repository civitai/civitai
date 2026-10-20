import { describe, expect, it } from 'vitest';
import { workflowOptions } from '../config/workflows';
import { getWorkflowsForMediaType, workflowHasField } from '../workflow-media';

/**
 * `workflowHasField` is a store probe: it resolves the hub for a workflow pin and asks
 * whether the field is present. The frozen tables below are the regression net — the probe
 * answers for the resolved form, so a field nested below the ecosystem level (`img2img:edit/model`,
 * `vid2vid:edit/video`, `txt2music/prompt`) counts as present. That is what puts
 * `vid2vid:edit` in the video-input set.
 */
const FIELDS = ['images', 'video', 'prompt', 'model'];

const PRESENT = new Set([
  'img2img/images',
  'img2img/model',
  'img2img/prompt',
  'img2img:avatar/images',
  'img2img:avatar/model',
  'img2img:edit/images',
  'img2img:edit/model',
  'img2img:edit/prompt',
  'img2img:face-fix/images',
  'img2img:face-fix/model',
  'img2img:face-fix/prompt',
  'img2img:hires-fix/images',
  'img2img:hires-fix/model',
  'img2img:hires-fix/prompt',
  'img2img:preprocess/images',
  'img2img:remove-background/images',
  'img2img:upscale/images',
  'img2model3d/images',
  'img2vid/images',
  'img2vid/model',
  'img2vid/prompt',
  'img2vid:first-last/images',
  'img2vid:first-last/model',
  'img2vid:first-last/prompt',
  'img2vid:ref2vid/images',
  'img2vid:ref2vid/model',
  'img2vid:ref2vid/prompt',
  'txt2img/model',
  'txt2img/prompt',
  'txt2img:draft/model',
  'txt2img:draft/prompt',
  'txt2img:face-fix/model',
  'txt2img:face-fix/prompt',
  'txt2img:hires-fix/model',
  'txt2img:hires-fix/prompt',
  'txt2model3d/prompt',
  'txt2music/images',
  'txt2music/model',
  'txt2music/prompt',
  'txt2vid/model',
  'txt2vid/prompt',
  'vid2vid:edit/model',
  'vid2vid:edit/prompt',
  'vid2vid:edit/video',
  'vid2vid:interpolate/video',
  'vid2vid:preprocess/video',
  'vid2vid:upscale/video',
]);

const MEDIA_SETS: Record<string, string[]> = {
  image: [
    'img2img',
    'img2img:avatar',
    'img2img:edit',
    'img2img:face-fix',
    'img2img:hires-fix',
    'img2img:preprocess',
    'img2img:remove-background',
    'img2img:upscale',
    'img2model3d',
    'img2vid',
    'img2vid:first-last',
    'img2vid:ref2vid',
    'txt2music',
  ],
  video: ['vid2vid:edit', 'vid2vid:interpolate', 'vid2vid:preprocess', 'vid2vid:upscale'],
  audio: [],
  model3d: [],
};

describe('workflow media derivation', () => {
  it('has workflows to walk', () => {
    expect(workflowOptions.length).toBeGreaterThan(20);
  });

  it('reports exactly the frozen field table over the whole workflow grid', () => {
    const wrong: string[] = [];
    let present = 0;
    for (const w of workflowOptions) {
      for (const f of FIELDS) {
        const key = `${w.graphKey}/${f}`;
        const expected = PRESENT.has(key);
        const actual = workflowHasField(w.graphKey, f);
        if (actual) present++;
        if (actual !== expected) wrong.push(`${key}: expected ${expected}, got ${actual}`);
      }
    }
    expect(wrong).toEqual([]);
    // A probe that answered false everywhere would satisfy the loop above, since every
    // mismatch would read as "expected true, got false" — except it wouldn't, which is
    // what this second line makes explicit rather than implicit.
    expect(present, 'the probe found no fields at all').toBe(PRESENT.size);
  });

  it.each(Object.keys(MEDIA_SETS))('returns the frozen workflow set for %s input', (mediaType) => {
    expect(
      getWorkflowsForMediaType(mediaType as never)
        .map((w) => w.graphKey)
        .sort()
    ).toEqual(MEDIA_SETS[mediaType]);
  });
});
