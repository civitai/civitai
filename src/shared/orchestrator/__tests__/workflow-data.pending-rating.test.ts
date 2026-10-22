import { describe, expect, it } from 'vitest';

import { WorkflowData } from '~/shared/orchestrator/workflow-data';

/** An output reported available before it is rated must stay out of the displayable lists until the rating lands. */
const blob = (overrides: Record<string, unknown> = {}) => ({
  type: 'image' as const,
  id: 'blob-1',
  url: 'https://x/1.jpeg',
  available: true,
  ...overrides,
});

const build = (
  output: Array<Record<string, unknown>>,
  holdUnrated = true,
  stepMetadata: Record<string, unknown> = {}
) =>
  new WorkflowData(
    {
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: false,
      metadata: {},
      steps: [{ $type: 'comfy', name: '$0', status: 'succeeded', metadata: stepMetadata, output }],
    } as any,
    { domain: { green: false } as any, nsfwEnabled: true, holdUnrated }
  );

describe('WorkflowData unrated outputs', () => {
  it('holds an available image with no rating out of every displayable list', () => {
    const wf = build([blob()]);

    expect(wf.displayOutput).toEqual([]);
    expect(wf.succeededOutput).toEqual([]);
    expect(wf.steps[0].output[0].pendingRating).toBe(true);
  });

  it('holds an unrated video the same way', () => {
    const wf = build([blob({ type: 'video' })]);

    expect(wf.displayOutput).toEqual([]);
    expect(wf.succeededOutput).toEqual([]);
  });

  it('shows the same output once it carries a rating', () => {
    const wf = build([blob({ nsfwLevel: 'pg' })]);

    expect(wf.displayOutput.map((x) => x.id)).toEqual(['blob-1']);
    expect(wf.succeededOutput.map((x) => x.id)).toEqual(['blob-1']);
    expect(wf.steps[0].output[0].pendingRating).toBe(false);
  });

  it('lists held outputs for the placeholder, and only those', () => {
    const wf = build([blob({ id: 'held' }), blob({ id: 'rated', nsfwLevel: 'pg' })]);

    expect(wf.pendingRatingOutput.map((x) => x.id)).toEqual(['held']);
    expect(wf.steps[0].pendingRatingOutput.map((x) => x.id)).toEqual(['held']);
  });

  it('gives no placeholder for a hidden output or a suppressed intermediate step', () => {
    const hidden = build([blob()], true, { output: { 'blob-1': { hidden: true } } });
    const suppressed = build([blob()], true, { suppressOutput: true });

    expect(hidden.pendingRatingOutput).toEqual([]);
    expect(suppressed.pendingRatingOutput).toEqual([]);
    // Held all the same: suppression only decides whether a placeholder is drawn.
    expect(suppressed.steps[0].output[0].pendingRating).toBe(true);
  });

  it('does not count a held output as blocked', () => {
    const wf = build([blob({ id: 'held' }), blob({ id: 'nsfw', blockedReason: 'NSFWLevel' })]);

    expect(wf.blockedCount).toBe(1);
    expect(wf.blockedReasons).toEqual(['NSFWLevel']);
  });

  // The orchestrator writes 'none' for "no block"; it must not read as a block that skips the hold.
  it("holds an unrated output whose blockedReason is 'none'", () => {
    const wf = build([blob({ blockedReason: 'none' })]);

    expect(wf.steps[0].output[0].pendingRating).toBe(true);
    expect(wf.displayOutput).toEqual([]);
  });

  it('leaves outputs that are never rated alone', () => {
    const wf = build([
      blob({ id: 'a', type: 'audio' }),
      blob({ id: 'm', type: 'model3d', format: 'glb' } as never),
      blob({ id: 'u', available: false }),
    ]);

    expect(wf.steps[0].output.map((x) => x.pendingRating)).toEqual([false, false, false]);
  });

  it("shows a video the orchestrator marks 'na' (never scanned), on green and in a private generation", () => {
    const wf = new WorkflowData(
      {
        id: 'wf-1',
        status: 'succeeded',
        allowMatureContent: false,
        metadata: { isPrivateGeneration: true },
        steps: [
          {
            $type: 'videoGen',
            name: '$0',
            status: 'succeeded',
            metadata: {},
            output: [blob({ type: 'video', nsfwLevel: 'na' })],
          },
        ],
      } as any,
      { domain: { green: true } as any, nsfwEnabled: false, holdUnrated: true }
    );

    expect(wf.steps[0].output[0].blockedReason).toBeFalsy();
    expect(wf.displayOutput.map((x) => x.id)).toEqual(['blob-1']);
  });

  describe('video from an engine the orchestrator never rates', () => {
    const buildStep = (
      $type: string,
      output: Record<string, unknown>,
      stepMetadata: Record<string, unknown>,
      workflowParams: Record<string, unknown> = {}
    ) =>
      new WorkflowData(
        {
          id: 'wf-1',
          status: 'succeeded',
          allowMatureContent: false,
          metadata: { params: workflowParams },
          steps: [
            { $type, name: '$0', status: 'succeeded', metadata: stepMetadata, output: [output] },
          ],
        } as any,
        { domain: { green: true } as any, nsfwEnabled: true, holdUnrated: true }
      );
    const held = (wf: WorkflowData) => wf.steps[0].output[0].pendingRating;
    const video = blob({ type: 'video' });

    it.each(['Grok', 'Kling', 'Veo3', 'Vidu'])('shows %s video unrated', (ecosystem) => {
      const wf = buildStep('videoGen', video, { params: { ecosystem } });

      expect(held(wf)).toBe(false);
      expect(wf.succeededOutput.map((x) => x.id)).toEqual(['blob-1']);
    });

    it('reads the ecosystem from the workflow when the step has no params', () => {
      expect(held(buildStep('videoGen', video, {}, { ecosystem: 'Kling' }))).toBe(false);
    });

    it('still holds images, rated engines, and upscales of a never-rated video', () => {
      expect(held(buildStep('videoGen', blob(), { params: { ecosystem: 'Kling' } }))).toBe(true);
      expect(held(buildStep('videoGen', video, { params: { ecosystem: 'MiniMaxH3' } }))).toBe(true);
      // An enhancement step stores its source generation's params, ecosystem included.
      expect(held(buildStep('videoUpscaler', video, { params: { ecosystem: 'Kling' } }))).toBe(
        true
      );
    });

    it('ignores the workflow ecosystem when the step has its own complete params', () => {
      const wf = buildStep('videoGen', video, { params: { prompt: 'x' } }, { ecosystem: 'Veo3' });

      expect(held(wf)).toBe(true);
    });
  });

  it('keeps an orchestrator block on an unrated output', () => {
    const wf = build([blob({ blockedReason: 'NSFWLevel' })]);

    expect(wf.steps[0].output[0].pendingRating).toBe(false);
    expect(wf.blockedReasons).toEqual(['NSFWLevel']);
  });

  it('is off unless the caller asks for it', () => {
    const wf = build([blob()], false);

    expect(wf.steps[0].output[0].pendingRating).toBe(false);
    expect(wf.displayOutput.map((x) => x.id)).toEqual(['blob-1']);
  });
});
