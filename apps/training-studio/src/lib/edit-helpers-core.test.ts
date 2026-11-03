import { describe, expect, it, vi } from 'vitest';
import { submitEditImage, submitSuggest } from './edit-helpers-core';

const submitWorkflow = vi.fn();
// Hand-listed: the client's dist imports a directory, which Node's ESM loader refuses.
vi.mock('@civitai/orchestration-client', () => ({
  getWorkflow: vi.fn(),
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
}));

const client = {} as Parameters<typeof submitEditImage>[0];
const blob = 'https://orchestration.civitai.com/v2/consumer/blobs/abc.png';

describe('edit helper submits', () => {
  it.each([
    [
      'create the after image',
      () => submitEditImage(client, { imageUrl: blob, prompt: 'turn left' }),
    ],
    ['suggest an instruction', () => submitSuggest(client, { beforeUrl: blob, afterUrl: blob })],
  ])('%s uses manual upgrade mode and never unlocks mature content', async (_, run) => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-1' } });
    await expect(run()).resolves.toBe('wf-1');
    const body = submitWorkflow.mock.calls.at(-1)![0].body;
    expect(body.upgradeMode).toBe('manual');
    expect(body.allowMatureContent).toBe(false);
  });
});
