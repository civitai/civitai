import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';

const clientUpdateWorkflow = vi.fn();
const getWorkflow = vi.fn();
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  updateWorkflow: (...args: unknown[]) => clientUpdateWorkflow(...args),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
}));

import { updateWorkflow } from '../orchestration-new.service';

const video = (nsfwLevel: string) => ({
  $type: 'videoGen',
  name: '$0',
  status: 'succeeded',
  output: { video: { id: `${nsfwLevel}.mp4`, available: true, nsfwLevel, url: 'https://x' } },
});
const images = ($type: string, ...levels: string[]) => ({
  $type,
  name: $type,
  status: 'succeeded',
  output: {
    images: levels.map((nsfwLevel, i) => ({ id: `${i}.jpeg`, available: true, nsfwLevel })),
  },
});
const preprocess = (nsfwLevel: string) => ({
  $type: 'preprocessImage',
  name: 'pre',
  status: 'succeeded',
  output: { blob: { id: 'pre.jpeg', available: true, nsfwLevel } },
});

const viewer = { domain: 'red' as const, showNsfw: true };
const unlock = { token: 'tok', workflowId: '5-1', allowMatureContent: true, viewer };

beforeEach(() => {
  vi.clearAllMocks();
  clientUpdateWorkflow.mockResolvedValue({ id: '5-1', steps: [] });
});

describe('updateWorkflow unlock', () => {
  it('refuses to charge when every mature output is above the cap', async () => {
    getWorkflow.mockResolvedValue({ id: '5-1', nsfwLevel: 'pg13', steps: [video('r')] });

    await expect(updateWorkflow(unlock)).rejects.toThrow(/PG-13/);
    expect(clientUpdateWorkflow).not.toHaveBeenCalled();
  });

  it('refuses when only a non-mature output sits within the cap', async () => {
    getWorkflow.mockResolvedValue({
      id: '5-1',
      nsfwLevel: 'pg13',
      steps: [preprocess('pg13'), images('imageGen', 'r')],
    });

    await expect(updateWorkflow(unlock)).rejects.toThrow(/PG-13/);
    expect(clientUpdateWorkflow).not.toHaveBeenCalled();
  });

  it('charges an uncapped workflow', async () => {
    getWorkflow.mockResolvedValue({ id: '5-1', steps: [video('xxx')] });

    await updateWorkflow(unlock);
    expect(clientUpdateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: '5-1', allowMatureContent: true })
    );
  });

  it('leaves a capped workflow with no mature output to the orchestrator', async () => {
    getWorkflow.mockResolvedValue({
      id: '5-1',
      nsfwLevel: 'pg13',
      steps: [images('imageGen', 'pg')],
    });

    await updateWorkflow(unlock);
    expect(clientUpdateWorkflow).toHaveBeenCalledTimes(1);
  });

  it('charges when one mature output is within the cap', async () => {
    getWorkflow.mockResolvedValue({
      id: '5-1',
      nsfwLevel: 'r',
      steps: [images('imageGen', 'r', 'xxx')],
    });

    await updateWorkflow(unlock);
    expect(clientUpdateWorkflow).toHaveBeenCalledTimes(1);
  });

  it('surfaces an orchestrator refusal and does not forward the viewer', async () => {
    getWorkflow.mockResolvedValue({ id: '5-1', steps: [] });

    await updateWorkflow(unlock);
    expect(clientUpdateWorkflow).toHaveBeenCalledWith({
      token: 'tok',
      workflowId: '5-1',
      allowMatureContent: true,
      throwOnError: true,
    });
  });

  it('leaves a metadata-only update unchecked', async () => {
    await updateWorkflow({ token: 'tok', workflowId: '5-1', metadata: { a: 1 } });

    expect(getWorkflow).not.toHaveBeenCalled();
    expect(clientUpdateWorkflow).toHaveBeenCalledTimes(1);
  });
});
