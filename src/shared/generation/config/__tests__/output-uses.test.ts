import { describe, expect, it } from 'vitest';

import { AVATAR_WORKFLOW } from '~/shared/constants/avatar-styles.constants';
import { canUseWorkflowOutput } from '~/shared/generation/config/output-uses';
import { OUTPUT_USES } from '~/shared/generation/config/types';
import { workflowConfigs } from '~/shared/generation/config/workflows';
import { WorkflowData } from '~/shared/orchestrator/workflow-data';

describe('canUseWorkflowOutput', () => {
  it.each(OUTPUT_USES)('refuses avatar results for %s', (use) => {
    expect(canUseWorkflowOutput(AVATAR_WORKFLOW, use)).toBe(false);
  });

  it('allows an output of a workflow with no config', () => {
    expect(canUseWorkflowOutput('textToImage', 'post')).toBe(true);
    expect(canUseWorkflowOutput(undefined, 'post')).toBe(true);
  });

  // Every other workflow states all uses today; a narrower one should be a deliberate choice here.
  it('restricts only the avatar workflow', () => {
    const restricted = Object.entries(workflowConfigs)
      .filter(([, config]) => config.outputUses.length < OUTPUT_USES.length)
      .map(([key]) => key);
    expect(restricted).toEqual([AVATAR_WORKFLOW]);
  });
});

describe('BlobData', () => {
  const outputOf = (
    workflowParams: Record<string, unknown>,
    stepParams: Record<string, unknown> = {}
  ) =>
    new WorkflowData(
      {
        id: 'wf-1',
        allowMatureContent: true,
        metadata: { params: workflowParams, resources: [] },
        steps: [
          {
            $type: 'imageGen',
            name: 'a',
            status: 'succeeded',
            metadata: { params: stepParams },
            output: [{ type: 'image', id: 'b', url: 'https://x/1.jpeg', available: true }],
          },
        ],
      } as never,
      { domain: { green: false } as never, nsfwEnabled: true }
    ).succeededOutput[0];

  it('reads the workflow key of the generation', () => {
    expect(outputOf({ workflow: AVATAR_WORKFLOW }).canUse('post')).toBe(false);
    expect(outputOf({ workflow: 'txt2img' }).canUse('post')).toBe(true);
  });

  it("goes by the generation's workflow over a step's", () => {
    expect(outputOf({ workflow: AVATAR_WORKFLOW }, { workflow: 'txt2img' }).canUse('derive')).toBe(
      false
    );
  });

  it('hides details by the same workflow key', () => {
    expect(outputOf({ workflow: AVATAR_WORKFLOW }, { workflow: 'txt2img' }).hideDetails).toBe(true);
    expect(outputOf({ workflow: 'txt2img' }).hideDetails).toBe(false);
  });
});
