import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CachesModule from '~/server/redis/caches';
import type * as WorkflowsModule from '~/server/services/orchestrator/workflows';

const { mockMetaFetch, mockQueryWorkflows } = vi.hoisted(() => ({
  mockMetaFetch: vi.fn(),
  mockQueryWorkflows: vi.fn(),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof CachesModule>()),
  imageMetaCache: { fetch: mockMetaFetch },
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsModule>()),
  queryWorkflows: mockQueryWorkflows,
}));

import { buildPromptOrigin } from '~/server/services/orchestrator/prompt-origin';

const SOURCE =
  'a watercolor painting of a lighthouse on a rocky coast at sunset, soft pastel clouds, detailed waves';

const metaFor = (id: number, prompt: string | null) => ({
  [id]: { id, meta: prompt === null ? null : { prompt } },
});

const enhancementWorkflow = (id: string, enhancedPrompt: string) => ({
  id,
  steps: [{ $type: 'promptEnhancement', output: { enhancedPrompt } }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockMetaFetch.mockResolvedValue({});
  mockQueryWorkflows.mockResolvedValue({ items: [] });
});

describe('buildPromptOrigin — remix', () => {
  it('a verified source with an unchanged prompt is identical', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5] });
    expect(origin?.remix).toMatchObject({ imageId: 5, verified: true, promptMatch: 'identical' });
  });

  it('whitespace and case differences still count as identical', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({
      prompt: `  ${SOURCE.toUpperCase()}  `,
      sourceImageIds: [5],
    });
    expect(origin?.remix?.promptMatch).toBe('identical');
  });

  it('a lightly edited prompt is edited, with a score', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({
      prompt: `${SOURCE}, birds flying`,
      sourceImageIds: [5],
    });
    expect(origin?.remix).toMatchObject({ verified: true, promptMatch: 'edited' });
    expect(origin?.remix?.score).toBeGreaterThan(0);
  });

  it('a different prompt is unrelated', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({
      prompt: 'portrait of a grizzled space marine, gritty cinematic lighting',
      sourceImageIds: [5],
    });
    expect(origin?.remix).toMatchObject({ imageId: 5, promptMatch: 'unrelated' });
  });

  it('hidden meta gives unknown', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, null));
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5] });
    expect(origin?.remix).toMatchObject({ imageId: 5, verified: true, promptMatch: 'unknown' });
  });

  it('an unverified remixOfId is recorded as unverified', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(9, SOURCE));
    const origin = await buildPromptOrigin({ prompt: SOURCE, remixOfId: 9, sourceImageIds: [] });
    expect(origin?.remix).toMatchObject({ imageId: 9, verified: false, promptMatch: 'identical' });
  });

  it('verified sources win over the client claim', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({ prompt: SOURCE, remixOfId: 9, sourceImageIds: [5] });
    expect(origin?.remix).toMatchObject({ imageId: 5, verified: true });
    expect(mockMetaFetch).toHaveBeenCalledWith([5]);
  });

  it('prefers the source that matches the prompt', async () => {
    mockMetaFetch.mockResolvedValue({
      ...metaFor(5, 'completely different words about trains and stations'),
      ...metaFor(6, SOURCE),
    });
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5, 6] });
    expect(origin?.remix).toMatchObject({ imageId: 6, promptMatch: 'identical' });
  });

  it('a failing meta lookup records unknown and does not throw', async () => {
    mockMetaFetch.mockRejectedValue(new Error('redis down'));
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5] });
    expect(origin?.remix).toMatchObject({ imageId: 5, verified: true, promptMatch: 'unknown' });
  });

  it('a hanging meta lookup is bounded', async () => {
    vi.useFakeTimers();
    try {
      mockMetaFetch.mockReturnValue(new Promise<never>(() => undefined));
      const pending = buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5] });
      await vi.advanceTimersByTimeAsync(10_000);
      const origin = await pending;
      expect(origin?.remix?.promptMatch).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('no remix candidates and no enhancer match gives no origin', async () => {
    expect(await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [] })).toBeUndefined();
    expect(mockMetaFetch).not.toHaveBeenCalled();
  });
});

describe('buildPromptOrigin — enhancer', () => {
  it('an unchanged enhancer output is identical', async () => {
    mockQueryWorkflows.mockResolvedValue({
      items: [
        enhancementWorkflow('wf-old', 'something else entirely'),
        enhancementWorkflow('wf-1', SOURCE),
      ],
    });
    const origin = await buildPromptOrigin({ prompt: SOURCE, token: 't' });
    expect(origin?.enhancer).toEqual({ workflowId: 'wf-1', promptMatch: 'identical' });
    expect(mockQueryWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ token: 't', tags: ['prompt-enhancement'] })
    );
  });

  it('a lightly edited enhancer output is edited', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [enhancementWorkflow('wf-1', SOURCE)] });
    const origin = await buildPromptOrigin({ prompt: `${SOURCE}, birds flying`, token: 't' });
    expect(origin?.enhancer).toEqual({ workflowId: 'wf-1', promptMatch: 'edited' });
  });

  it('an unrelated prompt records no enhancer origin', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [enhancementWorkflow('wf-1', SOURCE)] });
    const origin = await buildPromptOrigin({
      prompt: 'portrait of a grizzled space marine, gritty cinematic lighting',
      token: 't',
    });
    expect(origin).toBeUndefined();
  });

  it('is skipped without a token', async () => {
    await buildPromptOrigin({ prompt: SOURCE });
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  it('a failing workflow lookup omits the enhancer and keeps the remix', async () => {
    mockQueryWorkflows.mockRejectedValue(new Error('orchestrator down'));
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5], token: 't' });
    expect(origin?.enhancer).toBeUndefined();
    expect(origin?.remix?.promptMatch).toBe('identical');
  });

  it('a hanging workflow lookup is bounded', async () => {
    vi.useFakeTimers();
    try {
      mockQueryWorkflows.mockReturnValue(new Promise<never>(() => undefined));
      const pending = buildPromptOrigin({ prompt: SOURCE, token: 't' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
