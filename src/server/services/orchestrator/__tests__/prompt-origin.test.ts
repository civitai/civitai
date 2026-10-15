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

import { MAX_SOURCE_IMAGES } from '~/server/utils/source-image-ids';
import {
  backfilledPromptOrigin,
  buildPromptOrigin,
  prohibitedRowToTrigger,
} from '~/server/services/orchestrator/prompt-origin';

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
    expect(origin.remix).toMatchObject({ imageId: 5, verified: true, promptMatch: 'unknown' });
    expect(origin.incomplete).toBe(true);
  });

  it('no remix candidates and no enhancer match gives no origin', async () => {
    expect(await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [] })).toEqual({});
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
    expect(origin?.enhancer).toEqual({
      workflowId: 'wf-1',
      promptMatch: 'identical',
      verified: false,
    });
    expect(mockQueryWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ token: 't', tags: ['prompt-enhancement'] })
    );
  });

  it('a lightly edited enhancer output is edited', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [enhancementWorkflow('wf-1', SOURCE)] });
    const origin = await buildPromptOrigin({ prompt: `${SOURCE}, birds flying`, token: 't' });
    expect(origin?.enhancer).toEqual({
      workflowId: 'wf-1',
      promptMatch: 'edited',
      verified: false,
    });
  });

  it('an unrelated prompt records no enhancer origin', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [enhancementWorkflow('wf-1', SOURCE)] });
    const origin = await buildPromptOrigin({
      prompt: 'portrait of a grizzled space marine, gritty cinematic lighting',
      token: 't',
    });
    expect(origin).toEqual({});
  });

  it('is skipped without a token', async () => {
    await buildPromptOrigin({ prompt: SOURCE });
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  it('a failing workflow lookup omits the enhancer and keeps the remix', async () => {
    mockQueryWorkflows.mockRejectedValue(new Error('orchestrator down'));
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5], token: 't' });
    expect(origin.enhancer).toBeUndefined();
    expect('enhancer' in origin).toBe(false);
    expect(origin.incomplete).toBe(true);
    expect(origin.remix?.promptMatch).toBe('identical');
  });
});

describe('backfilledPromptOrigin', () => {
  it('records an unverified, unmatched remix for a row with remixOfId', () => {
    expect(backfilledPromptOrigin(42)).toEqual({
      remix: { imageId: 42, verified: false, promptMatch: 'unknown' },
    });
  });

  it('writes no origin for a row without remixOfId', () => {
    expect(backfilledPromptOrigin(null)).toBeUndefined();
    expect(backfilledPromptOrigin(0)).toBeUndefined();
  });
});

const PENDING = () => new Promise<never>(() => undefined);

describe('buildPromptOrigin — lookup timeout boundary', () => {
  const settled = async (pending: Promise<unknown>) => {
    let done = false;
    void pending.then(() => (done = true));
    return () => done;
  };

  it.each([
    ['remix', () => mockMetaFetch.mockReturnValue(PENDING()), { sourceImageIds: [5] }],
    ['enhancer', () => mockQueryWorkflows.mockReturnValue(PENDING()), { token: 't' }],
  ])('%s lookup is pending at 799ms and incomplete at 800ms', async (_, arrange, extra) => {
    vi.useFakeTimers();
    try {
      arrange();
      const pending = buildPromptOrigin({ prompt: SOURCE, ...extra });
      const isDone = await settled(pending);
      await vi.advanceTimersByTimeAsync(799);
      expect(isDone(), 'settled before 800ms').toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const origin = await pending;
      expect(origin.incomplete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hanging remix lookup keeps the unknown candidate', async () => {
    vi.useFakeTimers();
    try {
      mockMetaFetch.mockReturnValue(PENDING());
      const pending = buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5] });
      await vi.advanceTimersByTimeAsync(800);
      expect((await pending).remix).toMatchObject({ imageId: 5, promptMatch: 'unknown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late rejection after the timeout does not surface', async () => {
    vi.useFakeTimers();
    try {
      let reject!: (e: Error) => void;
      mockMetaFetch.mockReturnValue(new Promise((_, r) => (reject = r)));
      const pending = buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5] });
      await vi.advanceTimersByTimeAsync(800);
      await pending;
      reject(new Error('late'));
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildPromptOrigin — ranking and caps', () => {
  const candidates = (
    prompts: Record<number, string | null>,
    submitted: string,
    verified = true
  ) => {
    mockMetaFetch.mockResolvedValue(
      Object.assign({}, ...Object.entries(prompts).map(([id, p]) => metaFor(Number(id), p)))
    );
    return buildPromptOrigin({
      prompt: submitted,
      ...(verified ? { sourceImageIds: Object.keys(prompts).map(Number) } : {}),
    });
  };
  const UNRELATED = 'portrait of a grizzled space marine, gritty cinematic lighting';
  const EDITED = `${SOURCE}, birds flying`;

  it.each([
    ['unknown over nothing', { 1: null }, SOURCE, 1, 'unknown'],
    ['unrelated beats unknown', { 1: null, 2: UNRELATED }, SOURCE, 2, 'unrelated'],
    ['edited beats unrelated', { 1: UNRELATED, 2: SOURCE }, EDITED, 2, 'edited'],
    ['identical beats edited', { 1: SOURCE, 2: EDITED }, EDITED, 2, 'identical'],
  ] as const)('%s', async (_, prompts, submitted, winner, match) => {
    const origin = await candidates({ ...prompts }, submitted);
    expect(origin.remix).toMatchObject({ imageId: winner, promptMatch: match });
  });

  it('fetches at most the cap of deduped ids', async () => {
    mockMetaFetch.mockResolvedValue({});
    const many = Array.from({ length: MAX_SOURCE_IMAGES + 4 }, (_, i) => i + 1);
    await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [1, ...many] });
    const ids = mockMetaFetch.mock.calls[0][0] as number[];
    expect(ids).toEqual(many.slice(0, MAX_SOURCE_IMAGES));
  });

  it('an earlier edited enhancer output yields to a later identical one', async () => {
    mockQueryWorkflows.mockResolvedValue({
      items: [
        enhancementWorkflow('wf-edit', `${SOURCE}, birds flying`),
        enhancementWorkflow('wf-same', SOURCE),
      ],
    });
    const origin = await buildPromptOrigin({ prompt: SOURCE, token: 't' });
    expect(origin.enhancer).toMatchObject({ workflowId: 'wf-same', promptMatch: 'identical' });
  });

  it('finds the step by name when it has no type', async () => {
    mockQueryWorkflows.mockResolvedValue({
      items: [
        {
          id: 'wf-named',
          steps: [{ name: 'prompt-enhancement', output: { enhancedPrompt: SOURCE } }],
        },
      ],
    });
    const origin = await buildPromptOrigin({ prompt: SOURCE, token: 't' });
    expect(origin.enhancer).toMatchObject({ workflowId: 'wf-named' });
  });

  it('skips a blank enhancedPrompt', async () => {
    mockQueryWorkflows.mockResolvedValue({ items: [enhancementWorkflow('wf-blank', '   ')] });
    expect(await buildPromptOrigin({ prompt: SOURCE, token: 't' })).toEqual({});
  });

  it('never writes a null remix or enhancer', async () => {
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [], token: 't' });
    expect(Object.keys(origin)).toEqual([]);
  });
});

describe('buildPromptOrigin — incomplete', () => {
  it('is set when the workflow lookup rejects', async () => {
    mockQueryWorkflows.mockRejectedValue(new Error('down'));
    expect(await buildPromptOrigin({ prompt: SOURCE, token: 't' })).toEqual({ incomplete: true });
  });

  it('is set when the meta lookup rejects', async () => {
    mockMetaFetch.mockRejectedValue(new Error('down'));
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5] });
    expect(origin.incomplete).toBe(true);
  });

  it('is absent when every lookup succeeded', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({ prompt: SOURCE, sourceImageIds: [5], token: 't' });
    expect('incomplete' in origin).toBe(false);
  });

  it('an internal failure degrades to incomplete', async () => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
    const origin = await buildPromptOrigin({
      prompt: undefined as unknown as string,
      sourceImageIds: [5],
    });
    expect(origin.incomplete).toBe(true);
  });
});

describe('prohibitedRowToTrigger', () => {
  const row = (remixOfId: number | null) => ({
    prompt: 'p',
    negativePrompt: '',
    source: 'Regex',
    remixOfId,
    inputImages: [],
    inputVideo: null,
    createdDate: '2026-01-01 00:00:00',
  });

  it('maps remixOfId to an unverified unknown remix origin', () => {
    expect(prohibitedRowToTrigger(row(42)).origin).toEqual({
      remix: { imageId: 42, verified: false, promptMatch: 'unknown' },
    });
  });

  it('writes no origin for a row without remixOfId', () => {
    expect(prohibitedRowToTrigger(row(null)).origin).toBeUndefined();
  });
});
