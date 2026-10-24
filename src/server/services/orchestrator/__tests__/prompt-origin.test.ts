import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CachesModule from '~/server/redis/caches';
import type * as WorkflowsModule from '~/server/services/orchestrator/workflows';

const { mockMetaFetch, mockQueryWorkflows, mockReplaceTriggerOrigin } = vi.hoisted(() => ({
  mockMetaFetch: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockReplaceTriggerOrigin: vi.fn(),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof CachesModule>()),
  imageMetaCache: { fetch: mockMetaFetch },
}));
vi.mock('~/server/services/user-restriction.service', () => ({
  replaceTriggerOrigin: mockReplaceTriggerOrigin,
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsModule>()),
  queryWorkflows: mockQueryWorkflows,
}));

import { MAX_SOURCE_IMAGES } from '~/server/utils/source-image-ids';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import type { BlockedPromptEntry } from '~/server/services/orchestrator/promptAuditing';
import {
  REPLACE_ENTRY_BY_ID,
  attachPromptOrigin,
  backfilledPromptOrigin,
  blockedEntryIdNeedle,
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
  mockReplaceTriggerOrigin.mockResolvedValue(0);
  redisMock.sysRedis.eval.mockResolvedValue(0);
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
  ])('%s lookup is pending at 9999ms and incomplete at 10000ms', async (_, arrange, extra) => {
    vi.useFakeTimers();
    try {
      arrange();
      const pending = buildPromptOrigin({ prompt: SOURCE, ...extra });
      const isDone = await settled(pending);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(isDone(), 'settled before 10s').toBe(false);
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
      await vi.advanceTimersByTimeAsync(10_000);
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
      await vi.advanceTimersByTimeAsync(10_000);
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

  it('maps a whole row with a regex match', () => {
    expect(
      prohibitedRowToTrigger(
        {
          prompt: 'p',
          negativePrompt: 'n',
          source: 'Regex',
          remixOfId: 42,
          inputImages: ['a', 'b'],
          inputVideo: 'v',
          createdDate: '2026-01-01 00:00:00',
        },
        { check: 'poi', matchedText: 'word', regex: 'w.rd' }
      )
    ).toEqual({
      prompt: 'p',
      negativePrompt: 'n',
      source: 'Regex',
      category: 'poi',
      matchedWord: 'word',
      matchedRegex: 'w.rd',
      imageId: null,
      remixOfId: null,
      inputImages: ['a', 'b'],
      inputVideo: 'v',
      origin: { remix: { imageId: 42, verified: false, promptMatch: 'unknown' } },
      time: '2026-01-01 00:00:00',
    });
  });

  it('maps a whole row without a match: empty images and a null negative prompt are normalised', () => {
    expect(
      prohibitedRowToTrigger({
        prompt: 'p',
        negativePrompt: null,
        source: 'External',
        remixOfId: null,
        inputImages: [],
        inputVideo: null,
        createdDate: '2026-01-01 00:00:00',
      })
    ).toEqual({
      prompt: 'p',
      negativePrompt: '',
      source: 'External',
      category: undefined,
      matchedWord: undefined,
      matchedRegex: undefined,
      imageId: null,
      remixOfId: null,
      inputImages: undefined,
      inputVideo: undefined,
      origin: undefined,
      time: '2026-01-01 00:00:00',
    });
  });
});

describe('REPLACE_ENTRY_BY_ID', () => {
  it('is pinned, so any change to the script is deliberate', () => {
    expect(REPLACE_ENTRY_BY_ID).toMatchInlineSnapshot(`
      "
        local items = redis.call('LRANGE', KEYS[1], 0, 49)
        for i, raw in ipairs(items) do
          if string.find(raw, ARGV[1], 1, true) then
            redis.call('LSET', KEYS[1], i - 1, ARGV[2])
            return 1
          end
        end
        return 0
      "
    `);
  });

  it('builds the needle the stored entry carries', () => {
    expect(blockedEntryIdNeedle('0b8f')).toBe('"id":"0b8f"');
    expect(JSON.stringify({ id: '0b8f', prompt: 'x' })).toContain(blockedEntryIdNeedle('0b8f'));
  });
});

describe('REPLACE_ENTRY_BY_ID, run in Lua', () => {
  const KEY = 'generation:blocked-prompts:9';
  const stored = (id: string) => JSON.stringify({ id, prompt: `p-${id}` });
  let lua: LuaRedis;
  const replace = (id: string, next: string) =>
    lua.eval(REPLACE_ENTRY_BY_ID, { keys: [KEY], arguments: [blockedEntryIdNeedle(id), next] });

  beforeEach(() => {
    lua = createLuaRedis(0, { integerArgs: true });
  });

  it('swaps the element carrying the id in place and leaves the rest alone', async () => {
    lua.setList(KEY, [stored('a'), stored('b'), stored('c')]);
    expect(await replace('b', 'NEW')).toBe(1);
    expect(lua.list(KEY)).toEqual([stored('a'), 'NEW', stored('c')]);
  });

  it('replaces only the first match', async () => {
    lua.setList(KEY, [stored('a'), stored('a')]);
    expect(await replace('a', 'NEW')).toBe(1);
    expect(lua.list(KEY)).toEqual(['NEW', stored('a')]);
  });

  it('does not match an id that only shares a prefix', async () => {
    lua.setList(KEY, [stored('entry-10')]);
    expect(await replace('entry-1', 'NEW')).toBe(0);
    expect(lua.list(KEY)).toEqual([stored('entry-10')]);
  });

  it('scans only the 50 newest elements', async () => {
    const items = Array.from({ length: 51 }, (_, i) => stored(`e${i}`));
    lua.setList(KEY, items);
    expect(await replace('e50', 'NEW')).toBe(0);
    expect(await replace('e49', 'NEW')).toBe(1);
    expect(lua.list(KEY)?.[49]).toBe('NEW');
    expect(lua.list(KEY)?.[50]).toBe(stored('e50'));
  });

  it('returns 0 on a missing list', async () => {
    expect(await replace('a', 'NEW')).toBe(0);
    expect(lua.list(KEY)).toBeUndefined();
  });

  it('writes the built origin onto the stored entry through attachPromptOrigin', async () => {
    const entry: BlockedPromptEntry = {
      id: 'entry-1',
      prompt: SOURCE,
      negativePrompt: '',
      source: 'Regex',
      imageId: null,
      remixOfId: null,
      origin: { incomplete: true },
      time: '2026-01-01T00:00:00.000Z',
    };
    lua.setList(KEY, [JSON.stringify(entry), stored('older')]);
    redisMock.sysRedis.eval.mockImplementation((script: string, options: never) =>
      lua.eval(script, options)
    );
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));

    await attachPromptOrigin({
      userId: 9,
      entry,
      redisKey: KEY,
      prompt: SOURCE,
      sourceImageIds: [5],
    });

    const [head, rest] = lua.list(KEY) ?? [];
    expect(JSON.parse(head)).toEqual({
      ...entry,
      origin: { remix: { imageId: 5, verified: true, promptMatch: 'identical', score: 1 } },
    });
    expect(rest).toBe(stored('older'));
    expect(lua.errors).toEqual([]);
    expect(mockReplaceTriggerOrigin).not.toHaveBeenCalled();
  });
});

describe('attachPromptOrigin', () => {
  const { sysRedis } = redisMock;
  const KEY = 'generation:blocked-prompts:9';
  const entry: BlockedPromptEntry = {
    id: 'entry-1',
    prompt: SOURCE,
    negativePrompt: '',
    source: 'Regex',
    imageId: null,
    remixOfId: null,
    origin: { incomplete: true },
    time: '2026-01-01T00:00:00.000Z',
  };
  const attach = (extra: object = {}) =>
    attachPromptOrigin({
      userId: 9,
      entry,
      redisKey: KEY,
      prompt: SOURCE,
      sourceImageIds: [5],
      ...extra,
    });

  beforeEach(() => {
    mockMetaFetch.mockResolvedValue(metaFor(5, SOURCE));
  });

  it('replaces the list element by id with the entry carrying the built origin', async () => {
    sysRedis.eval.mockResolvedValue(1);
    await attach();
    expect(sysRedis.eval).toHaveBeenCalledTimes(1);
    const [script, options] = sysRedis.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] }
    ];
    expect(script).toContain('LSET');
    expect(options.keys).toEqual([KEY]);
    expect(options.arguments[0]).toBe(blockedEntryIdNeedle('entry-1'));
    const written = JSON.parse(options.arguments[1]);
    expect(written).toEqual({
      ...entry,
      origin: { remix: { imageId: 5, verified: true, promptMatch: 'identical', score: 1 } },
    });
    expect(mockReplaceTriggerOrigin).not.toHaveBeenCalled();
  });

  it('falls back to the restriction row when the element is no longer in the list', async () => {
    sysRedis.eval.mockResolvedValue(0);
    mockReplaceTriggerOrigin.mockResolvedValue(1);
    await attach();
    expect(mockReplaceTriggerOrigin).toHaveBeenCalledTimes(1);
    expect(mockReplaceTriggerOrigin).toHaveBeenCalledWith({
      userId: 9,
      entryId: 'entry-1',
      origin: { remix: { imageId: 5, verified: true, promptMatch: 'identical', score: 1 } },
    });
    expect(sysRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('retries once after a delay when found in neither place, then gives up quietly', async () => {
    vi.useFakeTimers();
    try {
      const done = attach();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(sysRedis.eval).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(done).resolves.toBeUndefined();
      expect(sysRedis.eval).toHaveBeenCalledTimes(2);
      expect(mockReplaceTriggerOrigin).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sysRedis.eval).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('succeeds on the retry when a mute wrote its row in between', async () => {
    vi.useFakeTimers();
    try {
      mockReplaceTriggerOrigin.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const done = attach();
      await vi.advanceTimersByTimeAsync(2_000);
      await done;
      expect(mockReplaceTriggerOrigin).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockReplaceTriggerOrigin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a failed lookup as incomplete rather than dropping the attach', async () => {
    sysRedis.eval.mockResolvedValue(1);
    mockMetaFetch.mockRejectedValue(new Error('down'));
    await attach();
    const options = sysRedis.eval.mock.calls[0][1] as { arguments: string[] };
    expect(JSON.parse(options.arguments[1]).origin).toMatchObject({ incomplete: true });
  });

  it('never throws, and logs, when redis and the database both fail', async () => {
    vi.useFakeTimers();
    try {
      sysRedis.eval.mockRejectedValue(new Error('redis down'));
      mockReplaceTriggerOrigin.mockRejectedValue(new Error('db down'));
      const done = attach();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(done).resolves.toBeUndefined();
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'prompt-origin-attach-error', type: 'error' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs once per attempt and gives up without throwing when both stores miss and the row update rejects', async () => {
    vi.useFakeTimers();
    try {
      sysRedis.eval.mockResolvedValue(0);
      mockReplaceTriggerOrigin.mockRejectedValue(new Error('db down'));
      const done = attach();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(done).resolves.toBeUndefined();
      expect(sysRedis.eval).toHaveBeenCalledTimes(2);
      expect(mockReplaceTriggerOrigin).toHaveBeenCalledTimes(2);
      const logged = loggingMock.logToAxiom.mock.calls.filter(
        ([e]) => (e as { name: string }).name === 'prompt-origin-attach-error'
      );
      expect(logged).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sysRedis.eval).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries after eval throws on the first attempt and succeeds on the second', async () => {
    vi.useFakeTimers();
    try {
      sysRedis.eval.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(1);
      const done = attach();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(done).resolves.toBeUndefined();
      expect(sysRedis.eval).toHaveBeenCalledTimes(2);
      expect(mockReplaceTriggerOrigin).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
