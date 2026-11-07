import { describe, expect, it } from 'vitest';

import {
  BLOCK_STEP_NAME,
  snapshotFromWorkflow,
  succeededWithoutMediaStepType,
  SUCCEEDED_WITHOUT_MEDIA_MIXED_LABEL,
  SUCCEEDED_WITHOUT_MEDIA_PASSTHROUGH_LABEL,
  WORKFLOW_METADATA_BLOCK_STEPS_KEY,
} from '../workflow.service';
import { getStepByOrchestratorType, postureProducesMedia } from '../steps';
import type { BlockWorkflowSnapshot } from '~/server/schema/blocks/workflow.schema';

/**
 * Which finished workflows `civitai_app_block_succeeded_without_media_total`
 * counts: those with a bridge-submitted MEDIA step that succeeded with no media
 * of its own. The snapshot is the REAL `snapshotFromWorkflow` output; the text
 * cases add the fields `attachModeratedStepTextOutputs` would, to show a
 * sibling's text does not cancel a media step's empty result.
 */

function wf(steps: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: 'wf_1',
    createdAt: '2026-11-07T00:00:00Z',
    status: 'succeeded',
    metadata: {},
    tags: [],
    arguments: {},
    steps,
    callbacks: [],
    cost: { total: 7 },
    ...over,
  } as never;
}
const step = (s: Record<string, unknown>) => ({ status: 'succeeded', metadata: {}, ...s });
const blob = (url: string, available = true) => ({ id: url, type: 'image', url, available });

function classify(workflow: never, extra: Partial<BlockWorkflowSnapshot> = {}): string | null {
  return succeededWithoutMediaStepType(workflow, { ...snapshotFromWorkflow(workflow), ...extra });
}

describe('succeededWithoutMediaStepType', () => {
  it('🔴 #8132 shape: a succeeded comfy step whose blobs never reached the snapshot', () => {
    // No blobs at all, as the pre-#8132 extractor saw it (it read output.images).
    expect(classify(wf([step({ $type: 'comfy', name: 's1', output: { images: [] } })]))).toBe(
      'comfy'
    );
  });

  it('a media step whose blobs the orchestrator reports unavailable is counted', () => {
    const w = wf([
      step({ $type: 'imageGen', name: 's1', output: { images: [blob('https://cdn/a', false)] } }),
    ]);
    expect(classify(w)).toBe('imageGen');
  });

  it('NOT counted when the media arrived', () => {
    const w = wf([
      step({ $type: 'comfy', name: 's1', output: { blobs: [blob('https://cdn/c')] } }),
    ]);
    expect(snapshotFromWorkflow(w).imageUrls).toEqual(['https://cdn/c']);
    expect(classify(w)).toBeNull();
  });

  it.each(['failed', 'canceled', 'expired', 'processing'])(
    'NOT counted for a %s workflow, even with no media',
    (status) => {
      const w = wf([step({ $type: 'comfy', name: 's1', status, output: { blobs: [] } })], {
        status,
      });
      expect(classify(w)).toBeNull();
    }
  );

  describe('text-posture steps deliver no media by design', () => {
    it('the chatCompletion registry entry IS text-posture (precondition)', () => {
      const entry = getStepByOrchestratorType('chatCompletion');
      expect(entry).toBeDefined();
      expect(postureProducesMedia(entry!.moderationPosture)).toBe(false);
    });

    it('NOT counted for a text-only success — even with no text on the snapshot', () => {
      // The strict case: excluded by posture, not by the presence of textOutputs.
      const w = wf([step({ $type: 'chatCompletion', name: BLOCK_STEP_NAME, output: {} })]);
      expect(classify(w)).toBeNull();
    });

    it('NOT counted for a text-only success with released text', () => {
      const w = wf([step({ $type: 'chatCompletion', name: BLOCK_STEP_NAME, output: {} })]);
      expect(classify(w, { textOutputs: ['hello'] })).toBeNull();
    });

    it('🔴 PER MEDIA STEP: text delivered beside an image step that delivered nothing IS counted', () => {
      const w = wf([
        step({ $type: 'chatCompletion', name: 'a', output: {} }),
        step({ $type: 'textToImage', name: 'b', output: { images: [] } }),
      ]);
      // The sibling's text (or tool calls, or a withheld notice) does not stand in
      // for the images the viewer paid for. Labelled with the IMAGE step's type.
      expect(classify(w, { textOutputs: ['x'] })).toBe('textToImage');
      expect(classify(w, { toolCalls: [{} as never] })).toBe('textToImage');
      expect(classify(w, { textOutputWithheld: { reason: 'r' } })).toBe('textToImage');
    });

    it('NOT counted when the media step delivered, beside a text step', () => {
      const w = wf([
        step({ $type: 'chatCompletion', name: 'a', output: {} }),
        step({ $type: 'comfy', name: 'b', output: { blobs: [blob('https://cdn/b')] } }),
      ]);
      expect(classify(w, { textOutputs: ['x'] })).toBeNull();
    });
  });

  it('two media steps, one delivered and one did not: counted under the EMPTY one', () => {
    const w = wf([
      step({ $type: 'comfy', name: 'a', output: { blobs: [blob('https://cdn/a')] } }),
      step({ $type: 'imageGen', name: 'b', output: { images: [] } }),
    ]);
    // The snapshot is not empty — the comfy image reached it.
    expect(snapshotFromWorkflow(w).imageUrls).toEqual(['https://cdn/a']);
    expect(classify(w)).toBe('imageGen');
  });

  it('a media step whose OWN status is not succeeded is not counted', () => {
    const w = wf([step({ $type: 'comfy', name: 's1', status: 'failed', output: { blobs: [] } })]);
    expect(classify(w)).toBeNull();
  });

  it('NOT counted for a training-only success (it delivers epochs, after approval)', () => {
    const w = wf([step({ $type: 'training', name: BLOCK_STEP_NAME })]);
    expect(classify(w)).toBeNull();
  });

  it('a media-producing registered step that delivered nothing is labelled by its $type', () => {
    const entry = getStepByOrchestratorType('convertImage');
    expect(entry && postureProducesMedia(entry.moderationPosture)).toBe(true);
    const w = wf([step({ $type: 'convertImage', name: BLOCK_STEP_NAME, output: {} })]);
    expect(classify(w)).toBe('convertImage');
  });

  describe('pass-through steps', () => {
    // No `output` key: a pass-through step with ANY output (even `null` or an empty
    // shell left after its blobs were lifted) reaches `stepOutputs`, which counts as
    // delivered.
    it('collapse to one bounded label, whatever $type the app chose', () => {
      for (const $type of ['someVendorStep', 'anotherOne']) {
        const w = wf([step({ $type, name: BLOCK_STEP_NAME })]);
        expect(classify(w)).toBe(SUCCEEDED_WITHOUT_MEDIA_PASSTHROUGH_LABEL);
      }
    });

    it('NOT counted when the step returned non-blob output (it reached stepOutputs)', () => {
      const w = wf([step({ $type: 'someVendorStep', name: BLOCK_STEP_NAME, output: { n: 1 } })]);
      expect(snapshotFromWorkflow(w).stepOutputs).toHaveLength(1);
      expect(classify(w)).toBeNull();
    });

    it('a step this bridge did NOT submit is not expected to deliver anything', () => {
      const w = wf([step({ $type: 'someVendorStep', name: 'platform-step' })]);
      expect(classify(w)).toBeNull();
    });
  });

  it('several distinct expected types are "mixed"', () => {
    const w = wf([
      step({ $type: 'comfy', name: 'a', output: { blobs: [] } }),
      step({ $type: 'imageGen', name: 'b', output: { images: [] } }),
    ]);
    expect(classify(w)).toBe(SUCCEEDED_WITHOUT_MEDIA_MIXED_LABEL);
  });

  describe("kind:'workflow' members", () => {
    const meta = (steps: Array<{ name: string; suppressOutput?: true }>) => ({
      metadata: { [WORKFLOW_METADATA_BLOCK_STEPS_KEY]: steps },
    });

    it('a member pass-through step that delivered nothing is counted', () => {
      const w = wf([step({ $type: 'someVendorStep', name: 'gen' })], meta([{ name: 'gen' }]));
      expect(classify(w)).toBe(SUCCEEDED_WITHOUT_MEDIA_PASSTHROUGH_LABEL);
    });

    it('an all-suppressOutput workflow expected no media and is NOT counted', () => {
      const w = wf(
        [step({ $type: 'comfy', name: 'gen', output: { blobs: [] } })],
        meta([{ name: 'gen', suppressOutput: true }])
      );
      expect(classify(w)).toBeNull();
    });
  });
});
