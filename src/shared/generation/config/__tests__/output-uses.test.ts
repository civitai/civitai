import { describe, expect, it } from 'vitest';

import { AVATAR_WORKFLOW } from '~/shared/constants/avatar-styles.constants';
import { canUseWorkflowOutput } from '~/shared/generation/config/output-uses';
import { OUTPUT_USES } from '~/shared/generation/config/types';
import { workflowConfigs } from '~/shared/generation/config/workflows';
import { WorkflowData } from '~/shared/orchestrator/workflow-data';

describe('canUseWorkflowOutput', () => {
  it.each(OUTPUT_USES)('refuses avatar results for %s', (use) => {
    expect(canUseWorkflowOutput(AVATAR_WORKFLOW, use).allowed).toBe(false);
  });

  it('names the workflow and the use', () => {
    expect(canUseWorkflowOutput(AVATAR_WORKFLOW, 'post')).toEqual({
      allowed: false,
      message: "Avatar results can't be posted",
    });
    expect(canUseWorkflowOutput(AVATAR_WORKFLOW, 'train')).toMatchObject({
      message: "Avatar results can't be used for training",
    });
  });

  it.each(OUTPUT_USES)('allows a txt2img result for %s', (use) => {
    expect(canUseWorkflowOutput('txt2img', use)).toEqual({ allowed: true });
  });

  it('allows an output of a workflow with no config', () => {
    expect(canUseWorkflowOutput('textToImage', 'post')).toEqual({ allowed: true });
    expect(canUseWorkflowOutput(undefined, 'post')).toEqual({ allowed: true });
  });

  // Every other workflow states all uses today; a narrower one should be a deliberate choice here.
  it('restricts only the avatar workflow', () => {
    const restricted = Object.entries(workflowConfigs)
      .filter(([, config]) => config.outputUses.length < OUTPUT_USES.length)
      .map(([key]) => key);
    expect(restricted).toEqual([AVATAR_WORKFLOW]);
  });
});

describe('BlobData.canUse', () => {
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
    expect(outputOf({ workflow: AVATAR_WORKFLOW }).canUse('post').allowed).toBe(false);
    expect(outputOf({ workflow: 'txt2img' }).canUse('post').allowed).toBe(true);
  });

  it("goes by the generation's workflow over a step's", () => {
    expect(
      outputOf({ workflow: AVATAR_WORKFLOW }, { workflow: 'txt2img' }).canUse('derive').allowed
    ).toBe(false);
  });
});
