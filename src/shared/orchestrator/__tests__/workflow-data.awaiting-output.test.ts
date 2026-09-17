import { describe, expect, it } from 'vitest';

import { WorkflowData } from '~/shared/orchestrator/workflow-data';
import type { WorkflowStatus } from '@civitai/client';

/**
 * Regression guard for the queue card's never-ending "Generating" tile.
 *
 * The orchestrator parks a workflow at `processing` when a mature result needs the
 * owner to act — `allowMatureContent: false` + `upgradeMode: 'manual'` holds the
 * step open until a yellow-Buzz unlock flips it. Workflow `5993188-20260916003811689`
 * sat there 77 minutes after its only job reported `Succeeded`, with both blobs
 * delivered and `available`, so anything keyed on status alone spun forever beside
 * the unlock CTA.
 */
const image = (overrides: Record<string, unknown> = {}) => ({
  type: 'image' as const,
  id: `blob-${Math.random()}`,
  url: 'https://x/1.jpeg',
  available: true,
  ...overrides,
});

const workflow = ({
  status,
  output = [],
  allowMatureContent = true,
  steps,
}: {
  status?: WorkflowStatus;
  output?: Array<Record<string, unknown>>;
  allowMatureContent?: boolean;
  steps?: Array<Record<string, unknown>>;
}) =>
  new WorkflowData(
    {
      id: 'wf-1',
      status,
      allowMatureContent,
      metadata: {},
      steps: steps ?? [{ $type: 'comfy', name: '$0', status, metadata: {}, output }],
    } as any,
    { domain: { green: false } as any, nsfwEnabled: true }
  );

describe('WorkflowData.awaitingOutput', () => {
  it('is false when a processing workflow has already delivered every output', () => {
    // The reported bug: a comfy step whose blobs all landed, held non-terminal.
    expect(workflow({ status: 'processing', output: [image(), image()] }).awaitingOutput).toBe(
      false
    );
  });

  // `canUpgrade` is set here rather than derived from `nsfwLevel: 'r'`, because the
  // global `@civitai/client` mock in src/__tests__/setup.ts substitutes an NsfwLevel
  // enum whose members don't exist in the real package, which makes `isMature` return
  // false for every level under test.
  it('is false when the delivered outputs are locked behind a yellow-Buzz unlock', () => {
    const wf = workflow({
      status: 'processing',
      allowMatureContent: false,
      output: [image({ blockedReason: 'canUpgrade' }), image({ blockedReason: 'canUpgrade' })],
    });
    expect(wf.processingCount).toBe(0);
    expect(wf.awaitingOutput).toBe(false);
  });

  it('is true while a step is running with nothing delivered yet', () => {
    expect(workflow({ status: 'processing', output: [] }).awaitingOutput).toBe(true);
  });

  it('is true while placeholder outputs have not landed', () => {
    const wf = workflow({
      status: 'processing',
      output: [image(), image({ available: false })],
    });
    expect(wf.processingCount).toBe(1);
    expect(wf.awaitingOutput).toBe(true);
  });

  it('is true for a queued workflow that has no steps yet', () => {
    expect(workflow({ status: 'scheduled', steps: [] }).awaitingOutput).toBe(true);
  });

  it('is true when any one step still owes output', () => {
    const wf = workflow({
      status: 'processing',
      steps: [
        { $type: 'comfy', name: '$0', status: 'succeeded', metadata: {}, output: [image()] },
        { $type: 'imageUpscaler', name: '$1', status: 'processing', metadata: {}, output: [] },
      ],
    });
    expect(wf.awaitingOutput).toBe(true);
  });

  it('is false once every step reaches a terminal status', () => {
    const statuses: WorkflowStatus[] = ['succeeded', 'failed', 'expired', 'canceled'];
    for (const status of statuses) {
      expect(workflow({ status, output: [] }).awaitingOutput, status).toBe(false);
    }
  });
});
