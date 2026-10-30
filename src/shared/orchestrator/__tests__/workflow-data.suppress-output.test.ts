import { describe, expect, it } from 'vitest';

import { WorkflowData } from '~/shared/orchestrator/workflow-data';

const image = () => ({
  type: 'image' as const,
  id: `blob-${Math.random()}`,
  url: 'https://x/1.jpeg',
  available: true,
});

const step = (
  $type: string,
  status: string,
  options: { suppressOutput?: boolean; output?: unknown[] } = {}
) => ({
  $type,
  name: `${$type}-${status}`,
  status,
  metadata: options.suppressOutput ? { suppressOutput: true } : {},
  output: options.output ?? [image()],
});

const workflow = (steps: Array<Record<string, unknown>>) =>
  new WorkflowData({ id: 'wf-1', allowMatureContent: true, metadata: {}, steps } as any, {
    domain: { green: false } as any,
    nsfwEnabled: true,
  });

const preprocess = (status = 'succeeded') =>
  step('preprocessImage', status, { suppressOutput: true });

describe('StepData.suppressOutput', () => {
  it('hides an intermediate step while the run succeeds', () => {
    const wf = workflow([preprocess(), step('imageGen', 'succeeded')]);
    expect(wf.steps[0].suppressOutput).toBe(true);
    expect(wf.succeededOutput).toHaveLength(1);
  });

  it('hides it while the next step is still running', () => {
    const wf = workflow([preprocess(), step('imageGen', 'processing', { output: [] })]);
    expect(wf.steps[0].suppressOutput).toBe(true);
  });

  it.each(['failed', 'expired', 'canceled'])(
    'shows a succeeded intermediate step once a later step is %s',
    (status) => {
      const wf = workflow([preprocess(), step('imageGen', status, { output: [] })]);
      expect(wf.steps[0].suppressOutput).toBe(false);
      expect(wf.succeededOutput).toHaveLength(1);
    }
  );

  it('keeps hiding an intermediate step that itself failed or produced nothing', () => {
    expect(
      workflow([preprocess('failed'), step('imageGen', 'canceled', { output: [] })]).steps[0]
        .suppressOutput
    ).toBe(true);
    expect(
      workflow([
        step('chatCompletion', 'succeeded', { suppressOutput: true, output: [] }),
        step('aceStepAudio', 'failed', { output: [] }),
      ]).steps[0].suppressOutput
    ).toBe(true);
  });

  it('only looks at LATER steps', () => {
    const wf = workflow([
      step('imageGen', 'failed', { output: [] }),
      step('model3DPreview', 'succeeded', { suppressOutput: true }),
    ]);
    expect(wf.steps[1].suppressOutput).toBe(true);
  });
});
