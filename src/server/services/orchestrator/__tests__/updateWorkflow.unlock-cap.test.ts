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

/** A locked workflow, as the queue sees it before an unlock: charged with safe Buzz. */
const locked = (nsfwLevel: string | undefined, ...steps: unknown[]) => ({
  id: '5-1',
  allowMatureContent: false,
  nsfwLevel,
  steps,
});

const refuses = async (message: RegExp) => {
  await expect(updateWorkflow(unlock)).rejects.toThrow(message);
  expect(clientUpdateWorkflow).not.toHaveBeenCalled();
};
const charges = async () => {
  await updateWorkflow(unlock);
  expect(clientUpdateWorkflow).toHaveBeenCalledTimes(1);
};

// One case per row of the unlock rule: unlock only when `allowMatureContent === false` and at least
// one output is rated r or higher and not above the workflow's `nsfwLevel` cap (null = no cap).
describe('updateWorkflow unlock', () => {
  it('refuses a workflow that is already unlocked', async () => {
    getWorkflow.mockResolvedValue({ ...locked(undefined, video('x')), allowMatureContent: true });
    await refuses(/already unlocked/);
  });

  it.each([null, undefined])(
    'refuses a workflow with no mature restriction (allowMatureContent %s)',
    async (allowMatureContent) => {
      getWorkflow.mockResolvedValue({ ...locked(undefined, video('x')), allowMatureContent });
      await refuses(/no mature restriction/);
    }
  );

  it('charges an uncapped workflow with a mature output', async () => {
    getWorkflow.mockResolvedValue(locked(undefined, video('xxx')));
    await charges();
  });

  it('charges an r-capped workflow with an output rated r', async () => {
    getWorkflow.mockResolvedValue(locked('r', images('imageGen', 'r', 'xxx')));
    await charges();
  });

  it('refuses an r-capped workflow whose mature outputs are all above r', async () => {
    getWorkflow.mockResolvedValue(locked('r', images('imageGen', 'x', 'xxx')));
    await refuses(/limited to R,/);
  });

  it.each([
    ['pg13', [video('r')]],
    ['pg13', [preprocess('pg13'), images('imageGen', 'r')]],
    ['pg13', [images('imageGen', 'pg')]],
    ['pg', []],
  ])('refuses a %s cap whatever its outputs', async (cap, steps) => {
    getWorkflow.mockResolvedValue(locked(cap, ...steps));
    await refuses(/limited to PG/);
  });

  it.each([
    ['nothing rated yet', [images('imageGen')]],
    ['only safe outputs', [images('imageGen', 'pg', 'pg13')]],
  ])('refuses an uncapped workflow with %s', async (_, steps) => {
    getWorkflow.mockResolvedValue(locked(undefined, ...steps));
    await refuses(/Nothing in this generation needs unlocking yet/);
  });

  it('surfaces an orchestrator refusal and does not forward the viewer', async () => {
    getWorkflow.mockResolvedValue(locked(undefined, video('x')));

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
