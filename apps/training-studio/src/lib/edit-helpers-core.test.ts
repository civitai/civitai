import { describe, expect, it, vi } from 'vitest';
import { editImageQuote } from './edit-helpers-core';

const submitWorkflow = vi.fn();
// Hand-listed: the client's dist imports a directory, which Node's ESM loader refuses.
vi.mock('@civitai/orchestration-client', () => ({
  getWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
}));

const client = {} as Parameters<typeof editImageQuote>[0];

describe('editImageQuote', () => {
  it('prices the run on the starting image itself, as a whatif', async () => {
    // The orchestrator downloads an edit's input even for a whatif: a placeholder URL left the
    // "Create the after image" dialog with no price at all.
    submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 36 } } });
    const start = 'https://orch.example/v2/consumer/blobs/start.png?sig=1';
    await expect(editImageQuote(client, start)).resolves.toBe(36);
    const { body, query } = submitWorkflow.mock.calls.at(-1)![0];
    expect(query).toEqual({ whatif: true });
    expect(body.steps[0].input.images).toEqual([start]);
  });
});
