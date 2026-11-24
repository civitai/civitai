import { describe, expect, it } from 'vitest';

import { NSFW_CAPPED, WorkflowData } from '~/shared/orchestrator/workflow-data';

/**
 * An output the orchestrator withheld as `MatureContent` (its workflow was created with mature
 * content off, e.g. on .com) offers its owner the unlock on .red when it carries a mature rating,
 * unless a cap rules it out. Without a readable rating it keeps the raw reason.
 */
const withheld = { type: 'image', id: 'blob-1', url: 'https://x/1.jpeg', available: false };

const outputOf = (
  output: Record<string, unknown>,
  { green = false, nsfwCap = null }: { green?: boolean; nsfwCap?: string | null } = {}
) =>
  new WorkflowData(
    {
      id: 'wf-1',
      status: 'succeeded',
      allowMatureContent: false,
      nsfwCap,
      metadata: {},
      steps: [
        { $type: 'imageGen', name: '$0', status: 'succeeded', metadata: {}, output: [output] },
      ],
    } as any,
    { domain: { green } as any }
  ).steps[0].output[0];

describe('WorkflowData: an output withheld as MatureContent', () => {
  it('offers the yellow unlock on .red', () => {
    const out = outputOf({ ...withheld, nsfwLevel: 'x', blockedReason: 'MatureContent' });
    expect(out.blockedReason).toBe('canUpgrade');
  });

  it('stays site-restricted on green', () => {
    const out = outputOf(
      { ...withheld, nsfwLevel: 'x', blockedReason: 'MatureContent' },
      { green: true }
    );
    expect(out.blockedReason).toBe('siteRestricted');
  });

  it('a capped workflow is not offered the unlock, which cannot lift the cap', () => {
    const out = outputOf(
      { ...withheld, nsfwLevel: 'x', blockedReason: 'MatureContent' },
      { nsfwCap: 'pg13' }
    );
    expect(out.blockedReason).toBe(NSFW_CAPPED);
  });

  it('keeps MatureContent when the output carries no rating the rules can read', () => {
    const out = outputOf({ ...withheld, blockedReason: 'MatureContent' });
    expect(out.blockedReason).toBe('MatureContent');
  });
});
