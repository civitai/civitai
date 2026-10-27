import { describe, expect, it } from 'vitest';

import { WorkflowData } from '~/shared/orchestrator/workflow-data';

/**
 * Private generation is limited to PG/PG-13, decided by the flag written at submit — not by the
 * resource's current availability, so publishing the model later does not release these outputs.
 */
const image = (overrides: Record<string, unknown> = {}) => ({
  type: 'image' as const,
  id: 'blob-1',
  url: 'https://x/1.png',
  available: true,
  ...overrides,
});

const build = (
  output: Array<Record<string, unknown>>,
  {
    workflowMetadata = {},
    stepMetadata = {},
  }: { workflowMetadata?: Record<string, unknown>; stepMetadata?: Record<string, unknown> } = {}
) =>
  new WorkflowData(
    {
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: true,
      nsfwCap: null,
      metadata: workflowMetadata,
      steps: [
        { $type: 'imageGen', name: '$0', status: 'succeeded', metadata: stepMetadata, output },
      ],
    } as any,
    { domain: { green: false } as any, nsfwEnabled: true }
  );

describe('WorkflowData private generation', () => {
  it('blocks mature output of an uncapped private generation', () => {
    const wf = build([image({ nsfwLevel: 'r' })], {
      workflowMetadata: { isPrivateGeneration: true },
    });

    expect(wf.steps[0].output[0].blockedReason).toBe('privateGen');
    expect(wf.displayOutput).toEqual([]);
  });

  it('honours the flag on step metadata from older workflows', () => {
    const wf = build([image({ nsfwLevel: 'x' })], { stepMetadata: { isPrivateGeneration: true } });

    expect(wf.steps[0].output[0].blockedReason).toBe('privateGen');
  });

  it('shows PG-13 output of a private generation', () => {
    const wf = build([image({ nsfwLevel: 'pg13' })], {
      workflowMetadata: { isPrivateGeneration: true },
    });

    expect(wf.displayOutput.map((x) => x.id)).toEqual(['blob-1']);
  });

  it('leaves mature output of a non-private generation unblocked', () => {
    const wf = build([image({ nsfwLevel: 'r' })], {
      workflowMetadata: { isPrivateGeneration: false },
    });

    expect(wf.steps[0].output[0].blockedReason).toBeFalsy();
    expect(wf.displayOutput.map((x) => x.id)).toEqual(['blob-1']);
  });
});
