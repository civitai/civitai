import { describe, expect, it } from 'vitest';

import { WorkflowData } from '~/shared/orchestrator/workflow-data';

/**
 * The orchestrator can report an output as available before it has rated it. Every mature gate
 * (`canUpgrade`, `enableNsfw`, `siteRestricted`) keys on the rating, so an unrated output must be
 * held back until the rating lands rather than shown as an ordinary result.
 */
const blob = (overrides: Record<string, unknown> = {}) => ({
  type: 'image' as const,
  id: 'blob-1',
  url: 'https://x/1.jpeg',
  available: true,
  ...overrides,
});

const build = (output: Array<Record<string, unknown>>, holdUnrated = true) =>
  new WorkflowData(
    {
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: false,
      metadata: {},
      steps: [{ $type: 'comfy', name: '$0', status: 'succeeded', metadata: {}, output }],
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

  // Positive control: the same fixture with a rating reaches the lists, so the empty lists above
  // come from the missing rating and not from something else in the fixture.
  it('shows the same output once it carries a rating', () => {
    const wf = build([blob({ nsfwLevel: 'pg' })]);

    expect(wf.displayOutput.map((x) => x.id)).toEqual(['blob-1']);
    expect(wf.succeededOutput.map((x) => x.id)).toEqual(['blob-1']);
    expect(wf.steps[0].output[0].pendingRating).toBe(false);
  });

  it('does not count a held output as blocked, processing or awaited', () => {
    const wf = build([blob()]);

    expect(wf.blockedCount).toBe(0);
    expect(wf.blockedReasons).toEqual([]);
    expect(wf.processingCount).toBe(0);
    expect(wf.awaitingOutput).toBe(false);
  });

  it('leaves outputs that are never rated alone', () => {
    const wf = build([
      blob({ id: 'a', type: 'audio' }),
      blob({ id: 'm', type: 'model3d' }),
      blob({ id: 'u', available: false }),
    ]);

    expect(wf.steps[0].output.map((x) => x.pendingRating)).toEqual([false, false, false]);
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
