import { describe, expect, it } from 'vitest';

import { NSFW_CAPPED, WorkflowData } from '~/shared/orchestrator/workflow-data';

/** An output rated above the workflow's cap is blocked even though the orchestrator reports it available. */
const video = (overrides: Record<string, unknown> = {}) => ({
  type: 'video' as const,
  id: 'blob-1',
  url: 'https://x/1.mp4',
  available: true,
  ...overrides,
});

const build = (
  output: Array<Record<string, unknown>>,
  {
    nsfwCap = 'pg13',
    allowMatureContent = true,
    green = false,
  }: { nsfwCap?: string | null; allowMatureContent?: boolean; green?: boolean } = {}
) =>
  new WorkflowData(
    {
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent,
      nsfwCap,
      metadata: {},
      steps: [{ $type: 'videoGen', name: '$0', status: 'succeeded', metadata: {}, output }],
    } as any,
    { domain: { green } as any, nsfwEnabled: true }
  );

describe('WorkflowData nsfw cap', () => {
  it('blocks a video rated above the cap instead of showing it as playable', () => {
    const wf = build([video({ nsfwLevel: 'xxx' })]);

    expect(wf.steps[0].output[0].blockedReason).toBe(NSFW_CAPPED);
    expect(wf.displayOutput).toEqual([]);
    expect(wf.succeededOutput).toEqual([]);
    expect(wf.blockedReasons).toEqual([NSFW_CAPPED]);
  });

  it('does not offer the yellow unlock, which cannot lift the cap', () => {
    const wf = build([video({ nsfwLevel: 'r' })], { allowMatureContent: false });

    expect(wf.steps[0].output[0].canUpgrade).toBe(false);
    expect(wf.steps[0].output[0].blockedReason).toBe(NSFW_CAPPED);
  });

  it('takes precedence over the civitai.red redirect on green', () => {
    const wf = build([video({ nsfwLevel: 'x' })], { green: true });

    expect(wf.steps[0].output[0].blockedReason).toBe(NSFW_CAPPED);
  });

  it('shows outputs at or below the cap', () => {
    const wf = build([
      video({ id: 'pg', nsfwLevel: 'pg' }),
      video({ id: 'pg13', nsfwLevel: 'pg13' }),
    ]);

    expect(wf.displayOutput.map((x) => x.id)).toEqual(['pg', 'pg13']);
  });

  it("ignores outputs rated 'na'", () => {
    const wf = build([video({ nsfwLevel: 'na' })]);

    expect(wf.steps[0].output[0].blockedReason).toBeFalsy();
  });

  it('keeps the orchestrator block reason when it sends one', () => {
    const wf = build([video({ nsfwLevel: 'xxx', available: false, blockedReason: 'NSFWLevel' })]);

    expect(wf.blockedReasons).toEqual(['NSFWLevel']);
  });

  it('falls through to the usual mature rules on an uncapped workflow', () => {
    const wf = build([video({ nsfwLevel: 'xxx' })], { nsfwCap: null, allowMatureContent: false });

    expect(wf.steps[0].output[0].canUpgrade).toBe(true);
  });
});
