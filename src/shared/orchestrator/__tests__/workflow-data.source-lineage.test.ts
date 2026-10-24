import { describe, expect, it } from 'vitest';

import { WorkflowData } from '~/shared/orchestrator/workflow-data';

/** Shaped after a real `vid2vid:interpolate` submission. */
const interpolateWorkflow = () =>
  new WorkflowData(
    {
      id: 'wf-interpolate',
      metadata: {
        params: {
          workflow: 'vid2vid:interpolate',
          video: { url: 'https://x/source.mp4' },
          interpolationFactor: 4,
          seed: 1337769042,
        },
      },
      steps: [
        {
          $type: 'videoInterpolation',
          metadata: {
            sourceLineage: true,
            params: {
              workflow: 'img2vid',
              ecosystem: 'MiniMaxH3',
              prompt: 'a cat',
              seed: 1188100909,
            },
            resources: [{ id: 3216500, strength: 1 }],
            remixOfId: 70956225,
          },
          output: [],
        },
      ],
    },
    { domain: { green: false } as any, nsfwEnabled: true }
  );

const standardWorkflow = () =>
  new WorkflowData(
    {
      id: 'wf-standard',
      metadata: { params: { workflow: 'txt2img', prompt: 'a dog' } },
      steps: [{ $type: 'textToImage', metadata: {}, output: [] }],
    },
    { domain: { green: false } as any, nsfwEnabled: true }
  );

describe('WorkflowData.sourceLineageStep', () => {
  it('finds the step holding the source generation for an enhancement workflow', () => {
    const step = interpolateWorkflow().sourceLineageStep;

    expect(step).toBeDefined();
    expect(step?.params.workflow).toBe('img2vid');
    expect(step?.params.prompt).toBe('a cat');
    expect(step?.resources).toEqual([{ id: 3216500, strength: 1 }]);
    expect(step?.remixOfId).toBe(70956225);
  });

  it('is undefined for a standard generation, so remix falls back to workflow metadata', () => {
    const workflow = standardWorkflow();

    expect(workflow.sourceLineageStep).toBeUndefined();
    expect(workflow.params.workflow).toBe('txt2img');
  });

  it('ignores an enhancement step that carries no source params', () => {
    const workflow = new WorkflowData(
      {
        id: 'wf-empty-source',
        metadata: { params: { workflow: 'img2img:upscale', images: [{ url: 'https://x/1.png' }] } },
        steps: [{ $type: 'comfy', metadata: { params: {}, resources: [] }, output: [] }],
      },
      { domain: { green: false } as any, nsfwEnabled: true }
    );

    expect(workflow.sourceLineageStep).toBeUndefined();
  });
});
