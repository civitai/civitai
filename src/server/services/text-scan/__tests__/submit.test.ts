import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as AdaptersModule from '~/server/services/moderation-adapters';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// @civitai/orchestration-client is mocked globally in src/__tests__/setup.ts (submitWorkflow/getWorkflow are vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof AdaptersModule>()),
  getModerationAdapter: vi.fn(),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));

const { scanEntity, scanEntitiesInBackground, textScanExternalId, textScanContentHash } =
  await import('~/server/services/text-scan/submit');
const { segmentUserText } = await import('~/server/services/text-scan/segment');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { submitWorkflow } = await import('@civitai/orchestration-client');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');
const { getActiveTextScanPrompts, getTextScanConfig, textScanTextHash } = await import(
  '~/server/services/text-scan/prompt'
);

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE PROMPT' },
  'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
};
const CONFIG = { model: 'air:test', maxInputChars: 1000, maxSegments: 10, thinking: false };
const load = vi.fn();
registerTextScanProfile({ entityType: 'Post', labels: ['nsfw'], minChars: 5, load });

const em = dbMock.dbWrite.entityModeration;
const row = (over: Record<string, unknown> = {}) => ({
  status: 'Succeeded',
  contentHash: 'other',
  workflowId: 'wf-0',
  retryCount: 0,
  updatedAt: new Date(1_000),
  ...over,
});
const externalIdOf = (call: number) =>
  vi.mocked(submitWorkflow).mock.calls[call][0].body!.externalId;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanMode).mockResolvedValue('shadow');
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
  load.mockResolvedValue(
    new Map([
      [7, { fields: [{ heading: 'Title', text: 'Hello world' }], declared: { nsfwLevel: 1 } }],
    ])
  );
  em.findUnique.mockResolvedValue(null);
  em.upsert.mockResolvedValue({} as any);
  em.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as any);
  redisMock.redis.set.mockResolvedValue('OK');
});
afterEach(() => resetEnv());

describe('scanEntity', () => {
  it('does nothing when the mode is off', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('off');
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'off',
    });
    expect(load).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('skips an entity type without a profile', async () => {
    expect(await scanEntity({ entityType: 'Bounty', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'no-profile',
    });
  });

  it('skips the retired ModelRules type without submitting a scan', async () => {
    expect(await scanEntity({ entityType: 'ModelRules', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'no-profile',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('skips a missing entity', async () => {
    load.mockResolvedValue(new Map());
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'missing',
    });
  });

  it('skips a not-public entity without reading or touching its stored verdict', async () => {
    // Short text too: a public entity this short would have its stale verdict cleared.
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'Title', text: 'x' }], declared: {}, notPublic: true }]])
    );
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'not-public',
    });
    expect(em.findUnique).not.toHaveBeenCalled();
    expect(em.upsert).not.toHaveBeenCalled();
    expect(em.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('skips without writing EM when a prompt row is missing, and logs the key', async () => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({ base: PROMPTS.base });
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'missing-prompt',
    });
    expect(em.upsert).not.toHaveBeenCalled();
    expect(em.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', type: 'error', missing: ['label:nsfw'] })
    );
  });

  it('logs a missing prompt key once per interval', async () => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({ base: PROMPTS.base });
    redisMock.redis.set.mockResolvedValueOnce(null);
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(redisMock.redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/text-scan:missing-prompt-logged:label:nsfw$/),
      '1',
      expect.objectContaining({ NX: true, EX: expect.any(Number) })
    );
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('does not log a missing prompt key when the throttle cannot be claimed', async () => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({ base: PROMPTS.base });
    redisMock.redis.set.mockRejectedValueOnce(new Error('redis down'));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'missing prompt rows' })
    );
  });

  it('measures minChars on raw field text, not the composed message with headings', async () => {
    // "## A long heading here\nhi" is 25 chars; the raw text is 2.
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'A long heading here', text: ' hi ' }], declared: {} }]])
    );
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'too-short',
    });
    expect(em.upsert).not.toHaveBeenCalled();
    expect(getActiveTextScanPrompts).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  describe('when the text is removed below minChars', () => {
    const applyTextScan = vi.fn();
    const verdict = (over: Record<string, unknown> = {}) => ({
      workflowId: 'wf-9',
      status: 'Succeeded',
      nsfwLevel: 16,
      triggeredLabels: ['nsfw'],
      result: { version: 1 },
      ...over,
    });
    beforeEach(() => {
      load.mockResolvedValue(
        new Map([[7, { fields: [{ heading: 'Detail', text: '' }], declared: { nsfwLevel: 1 } }]])
      );
      vi.mocked(getModerationAdapter).mockReturnValue({ applyTextScan } as any);
    });

    it('replaces an active raising verdict with a clean one and re-applies it', async () => {
      vi.mocked(getTextScanMode).mockResolvedValue('active');
      em.findUnique.mockResolvedValue(verdict() as any);
      expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
        status: 'skipped',
        reason: 'too-short',
      });
      const { where, data } = vi.mocked(em.updateMany).mock.calls[0][0] as any;
      expect(where).toMatchObject({ entityType: 'Post', entityId: 7 });
      expect(data).toMatchObject({ status: 'Succeeded', triggeredLabels: [] });
      expect(data.nsfwLevel ?? 1).toBeLessThanOrEqual(1);
      expect(applyTextScan).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 7, workflowId: 'wf-9' })
      );
      expect(submitWorkflow).not.toHaveBeenCalled();
    });

    it('clears the shadow row without applying anything', async () => {
      em.findUnique.mockResolvedValue(verdict() as any);
      await scanEntity({ entityType: 'Post', entityId: 7 });
      expect((vi.mocked(em.updateMany).mock.calls[0][0] as any).where).toMatchObject({
        entityType: 'Post:shadow',
      });
      expect(applyTextScan).not.toHaveBeenCalled();
    });

    it('leaves a clean verdict and a non-text-scan row untouched', async () => {
      vi.mocked(getTextScanMode).mockResolvedValue('active');
      em.findUnique.mockResolvedValue(verdict({ nsfwLevel: 1, triggeredLabels: [] }) as any);
      await scanEntity({ entityType: 'Post', entityId: 7 });
      em.findUnique.mockResolvedValue(verdict({ result: { labels: ['nsfw'] } }) as any);
      await scanEntity({ entityType: 'Post', entityId: 7 });
      expect(em.updateMany).not.toHaveBeenCalled();
      expect(applyTextScan).not.toHaveBeenCalled();
    });
  });

  it('scans text exactly at minChars', async () => {
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'T', text: 'hello' }], declared: {} }]])
    );
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
  });

  it('reads the EM row from the primary, never a replica', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(em.findUnique).toHaveBeenCalled();
    expect(dbMock.dbRead.entityModeration.findUnique).not.toHaveBeenCalled();
  });

  it('skips unchanged content that already succeeded', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const hash = vi.mocked(em.upsert).mock.calls[0][0].update.contentHash;
    vi.clearAllMocks();
    em.findUnique.mockResolvedValue(row({ contentHash: hash }));
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'unchanged',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(em.upsert).not.toHaveBeenCalled();
  });

  it('resubmits unchanged text whose row was parked Failed, re-arming its retries', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const hash = vi.mocked(em.upsert).mock.calls[0][0].update.contentHash;
    vi.clearAllMocks();
    em.findUnique.mockResolvedValue(row({ status: 'Failed', contentHash: hash, retryCount: 9 }));
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toMatchObject({
      status: 'submitted',
    });
    expect(vi.mocked(em.upsert).mock.calls[0][0].update).toMatchObject({
      status: 'Pending',
      retryCount: 0,
    });
  });

  it('skips text already in flight, unless forced or retried', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const hash = vi.mocked(em.upsert).mock.calls[0][0].update.contentHash;
    vi.clearAllMocks();
    const pending = row({
      status: 'Pending',
      contentHash: hash,
      updatedAt: new Date(Date.now() - 60_000),
    });
    em.findUnique.mockResolvedValue(pending);
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'in-flight',
    });
    expect(em.upsert).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();

    expect(await scanEntity({ entityType: 'Post', entityId: 7, force: true })).toMatchObject({
      status: 'submitted',
    });
    expect(await scanEntity({ entityType: 'Post', entityId: 7, fromRetry: true })).toMatchObject({
      status: 'submitted',
    });
  });

  it('resubmits a Pending row past the in-flight window, or with different text', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const hash = vi.mocked(em.upsert).mock.calls[0][0].update.contentHash;
    vi.clearAllMocks();
    em.findUnique.mockResolvedValueOnce(
      row({ status: 'Pending', contentHash: hash, updatedAt: new Date(Date.now() - 31 * 60_000) })
    );
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toMatchObject({
      status: 'submitted',
    });
    em.findUnique.mockResolvedValueOnce(
      row({ status: 'Pending', contentHash: 'other', updatedAt: new Date() })
    );
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toMatchObject({
      status: 'submitted',
    });
  });

  it('carries the uncapped text hash of the submitted subject', async () => {
    vi.mocked(getTextScanConfig).mockResolvedValue({ ...CONFIG, maxInputChars: 5 });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(vi.mocked(submitWorkflow).mock.calls[0][0].body!.metadata).toMatchObject({
      textHash: textScanTextHash({
        fields: [{ heading: 'Title', text: 'Hello world' }],
        declared: {},
      }),
    });
  });

  it('skips a subject whose every field is blank, so no empty step is submitted', async () => {
    load.mockResolvedValue(
      new Map([
        [
          7,
          {
            fields: [
              { heading: 'Title', text: '   ' },
              { heading: 'Body', text: null },
            ],
            declared: {},
          },
        ],
      ])
    );
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'too-short',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('skips text that composes to nothing even when the profile allows zero characters', async () => {
    registerTextScanProfile({ entityType: 'Article', labels: ['nsfw'], minChars: 0, load });
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'Body', text: '  ' }], declared: {} }]])
    );
    expect(await scanEntity({ entityType: 'Article', entityId: 7 })).toEqual({
      status: 'skipped',
      reason: 'too-short',
    });
    expect(em.upsert).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  describe('when the text composes to nothing past a zero minChars', () => {
    const raising = {
      workflowId: 'wf-9',
      status: 'Succeeded',
      nsfwLevel: 8,
      triggeredLabels: ['nsfw'],
      result: { version: 1 },
    };
    beforeEach(() => {
      registerTextScanProfile({ entityType: 'Article', labels: ['nsfw'], minChars: 0, load });
      load.mockResolvedValue(
        new Map([[7, { fields: [{ heading: 'Body', text: '   ' }], declared: {} }]])
      );
    });

    it("clears a stale raising verdict on the current pass's row", async () => {
      em.findUnique.mockResolvedValue(raising as any);
      expect(await scanEntity({ entityType: 'Article', entityId: 7 })).toEqual({
        status: 'skipped',
        reason: 'too-short',
      });
      expect(em.updateMany).toHaveBeenCalledTimes(1);
      const { where, data } = vi.mocked(em.updateMany).mock.calls[0][0] as any;
      expect(where).toMatchObject({ entityType: 'Article:shadow', entityId: 7 });
      expect(data).toMatchObject({ status: 'Succeeded', triggeredLabels: [], nsfwLevel: 1 });
      expect(submitWorkflow).not.toHaveBeenCalled();
    });

    it('writes nothing over a clean verdict', async () => {
      em.findUnique.mockResolvedValue({ ...raising, nsfwLevel: 1, triggeredLabels: [] } as any);
      await scanEntity({ entityType: 'Article', entityId: 7 });
      expect(em.updateMany).not.toHaveBeenCalled();
      expect(em.upsert).not.toHaveBeenCalled();
    });
  });

  const words = (count: number) =>
    Array.from({ length: count }, (_, i) => `w${String(i).padStart(4, '0')}`).join(' ');
  const LONG = {
    fields: [
      { heading: 'Title', text: 'Hello world' },
      { heading: 'Body', text: words(400) },
    ],
    declared: { nsfwLevel: 1 },
  };
  const sentBody = (call = 0) => vi.mocked(submitWorkflow).mock.calls[call][0].body!;

  it('carries inputChars, inputCut, segments and scannedChars in the workflow metadata', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(sentBody().metadata).toMatchObject({
      inputChars: '## Title\nHello world'.length,
      inputCut: false,
      segments: 1,
      scannedChars: '## Title\nHello world'.length,
    });
    load.mockResolvedValue(new Map([[7, LONG]]));
    vi.mocked(getTextScanConfig).mockResolvedValue({ ...CONFIG, maxSegments: 1 });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const expected = segmentUserText(LONG, { budget: 1000, maxSegments: 1 });
    expect(sentBody(1).metadata).toMatchObject({
      inputChars: expected.inputChars,
      inputCut: true,
      segments: 1,
      scannedChars: expected.scannedChars,
    });
  });

  it('submits one workflow whose steps are the segments, same system prompt in each', async () => {
    load.mockResolvedValue(new Map([[7, LONG]]));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    const expected = segmentUserText(LONG, { budget: 1000, maxSegments: 10 });
    expect(expected.segments.length).toBeGreaterThanOrEqual(3);
    const steps = sentBody().steps as any[];
    expect(steps.map((s) => s.name)).toEqual(
      expected.segments.map((_, i) => (i === 0 ? 'textScan' : `textScan${i}`))
    );
    expect(steps.map((s) => s.metadata)).toEqual(
      expected.segments.map((_, segment) => ({ segment }))
    );
    expect(steps.map((s) => s.input.messages[1].content)).toEqual(expected.segments);
    const systems = new Set(steps.map((s) => s.input.messages[0].content));
    expect(systems.size).toBe(1);
    expect(sentBody().metadata).toMatchObject({
      segments: expected.segments.length,
      inputCut: false,
    });
  });

  it('keeps the contentHash of a text within the budget exactly as before', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(em.upsert.mock.calls[0][0].create.contentHash).toBe(
      textScanContentHash({
        user: '## Title\nHello world',
        promptIds: { base: 1, nsfw: 2 },
        model: 'air:test',
        thinking: false,
      })
    );
    const steps = sentBody().steps as any[];
    expect(steps).toHaveLength(1);
    expect(Object.keys(steps[0]).sort()).toEqual(['$type', 'input', 'name']);
    expect(steps[0].name).toBe('textScan');
    expect(steps[0].input.messages[1].content).toBe('## Title\nHello world');
  });

  it('hashes the full text, so an edit past the scanned text is rescanned', async () => {
    vi.mocked(getTextScanConfig).mockResolvedValue({ ...CONFIG, maxSegments: 1 });
    load.mockResolvedValue(new Map([[7, LONG]]));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const edited = {
      ...LONG,
      fields: [LONG.fields[0], { heading: 'Body', text: `${words(400)} tail-edit` }],
    };
    load.mockResolvedValue(new Map([[7, edited]]));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(sentBody(1).metadata).toMatchObject({ inputCut: true });
    expect(sentBody(1).steps).toEqual(sentBody(0).steps);
    const [first, second] = em.upsert.mock.calls.map(([args]) => args.create.contentHash);
    expect(second).not.toBe(first);
  });

  it('hashes the segment budget only for text over maxInputChars', async () => {
    const hash = (user: string, maxInputChars: number, maxSegments: number) =>
      textScanContentHash({
        user,
        promptIds: { base: 1 },
        model: 'air:test',
        thinking: false,
        segmentBudget: { maxInputChars, maxSegments },
      });
    const plain = (user: string) =>
      textScanContentHash({ user, promptIds: { base: 1 }, model: 'air:test', thinking: false });
    const short = 'x'.repeat(1000);
    expect(hash(short, 1000, 10)).toBe(plain(short));
    expect(hash(short, 1000, 20)).toBe(hash(short, 1000, 10));
    expect(hash(short, 2000, 10)).toBe(plain(short));

    const long = 'x'.repeat(1001);
    expect(hash(long, 1000, 10)).not.toBe(plain(long));
    expect(hash(long, 1000, 20)).not.toBe(hash(long, 1000, 10));
    expect(hash(long, 500, 10)).not.toBe(hash(long, 1000, 10));
  });

  it('rescans a long entity when maxSegments changes, but not a short one', async () => {
    load.mockResolvedValue(new Map([[7, LONG]]));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    vi.mocked(getTextScanConfig).mockResolvedValue({ ...CONFIG, maxSegments: 20 });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const [longBefore, longAfter] = em.upsert.mock.calls.map(([args]) => args.create.contentHash);
    expect(longAfter).not.toBe(longBefore);

    vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'Title', text: 'Hello world' }], declared: {} }]])
    );
    await scanEntity({ entityType: 'Post', entityId: 7 });
    vi.mocked(getTextScanConfig).mockResolvedValue({ ...CONFIG, maxSegments: 20 });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const [, , shortBefore, shortAfter] = em.upsert.mock.calls.map(
      ([args]) => args.create.contentHash
    );
    expect(shortAfter).toBe(shortBefore);
  });

  it('a retry after a failed multi-segment scan resubmits every segment under a new externalId', async () => {
    load.mockResolvedValue(new Map([[7, LONG]]));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const hash = em.upsert.mock.calls[0][0].create.contentHash;
    em.findUnique.mockResolvedValueOnce(
      row({ status: 'Failed', contentHash: hash, retryCount: 1, workflowId: 'wf-1' })
    );
    await scanEntity({ entityType: 'Post', entityId: 7, fromRetry: true });
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
    expect((sentBody(1).steps as any[]).length).toBe((sentBody(0).steps as any[]).length);
    expect(externalIdOf(1)).not.toBe(externalIdOf(0));
  });

  it('rescans unchanged content when forced, with a fresh externalId', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const hash = vi.mocked(em.upsert).mock.calls[0][0].update.contentHash;
    em.findUnique.mockResolvedValue(row({ contentHash: hash }));
    await scanEntity({ entityType: 'Post', entityId: 7, force: true });
    expect(externalIdOf(1)).not.toBe(externalIdOf(0));
  });

  it('changes the externalId on each retry of the same text', async () => {
    em.findUnique.mockResolvedValueOnce(row({ status: 'Failed', workflowId: null, retryCount: 0 }));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    em.findUnique.mockResolvedValueOnce(row({ status: 'Failed', workflowId: null, retryCount: 1 }));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(externalIdOf(0)).not.toBe(externalIdOf(1));
  });

  it('A→B→A: the second submit of text A gets a fresh externalId', async () => {
    // Same text, same retryCount; only the row's updatedAt moved (the B scan wrote it).
    em.findUnique.mockResolvedValueOnce(row({ updatedAt: new Date(1_000) }));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    em.findUnique.mockResolvedValueOnce(row({ updatedAt: new Date(2_000) }));
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(externalIdOf(0)).not.toBe(externalIdOf(1));
  });

  it('concurrent submits on the same row state share one externalId', async () => {
    em.findUnique.mockResolvedValue(row());
    await Promise.all([
      scanEntity({ entityType: 'Post', entityId: 7 }),
      scanEntity({ entityType: 'Post', entityId: 7 }),
    ]);
    expect(externalIdOf(0)).toBe(externalIdOf(1));
  });

  it('submits one chatCompletion step with callbacks, no wait, no currencies, thinking off', async () => {
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    const call = vi.mocked(submitWorkflow).mock.calls[0][0];
    expect(call.query).toBeUndefined();
    expect(call.body!.currencies).toEqual([]);
    expect(call.body!.tags).toEqual(['text-scan', 'Post', 'shadow']);
    expect(call.body!.metadata).toMatchObject({
      entityType: 'Post',
      entityId: 7,
      promptIds: { base: 1, nsfw: 2 },
      model: 'air:test',
      labels: ['nsfw'],
      thinking: false,
      externalId: call.body!.externalId,
    });
    expect(call.body!.callbacks![0].url).toBe(
      'http://localhost:3000/api/webhooks/text-scan-result?token=test-webhook-token'
    );
    expect(call.body!.callbacks![0].type).toEqual([
      'workflow:succeeded',
      'workflow:failed',
      'workflow:expired',
      'workflow:canceled',
    ]);
    const step = call.body!.steps[0] as any;
    expect(step.$type).toBe('chatCompletion');
    expect(step.input).toMatchObject({
      model: 'air:test',
      temperature: 0,
      chatTemplateKwargs: { enable_thinking: false },
    });
    expect(step.input.responseFormat.jsonSchema.strict).toBe(true);
    expect(step.input.messages[0].content).toContain('NSFW DEF');
    expect(step.input.messages[1].content).toBe('## Title\nHello world');
  });

  it('uses TEXT_SCAN_CALLBACK verbatim when set, and the default when it is empty', async () => {
    setEnv({ TEXT_SCAN_CALLBACK: 'https://tunnel.example/api/webhooks/text-scan-result?token=t' });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(vi.mocked(submitWorkflow).mock.calls[0][0].body!.callbacks![0].url).toBe(
      'https://tunnel.example/api/webhooks/text-scan-result?token=t'
    );
    setEnv({ TEXT_SCAN_CALLBACK: '' });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(vi.mocked(submitWorkflow).mock.calls[1][0].body!.callbacks![0].url).toContain(
      'localhost:3000'
    );
  });

  it('sends thinking from config and hashes it', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    vi.mocked(getTextScanConfig).mockResolvedValue({ ...CONFIG, thinking: true });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    const [off, on] = vi.mocked(submitWorkflow).mock.calls.map((c) => c[0].body!);
    expect((on.steps[0] as any).input.chatTemplateKwargs).toEqual({ enable_thinking: true });
    expect(on.metadata).toMatchObject({ thinking: true });
    const hashes = vi.mocked(em.upsert).mock.calls.map((c) => c[0].update.contentHash);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(off.externalId).not.toBe(on.externalId);
  });

  it('carries the scanned subject meta in the workflow metadata, and omits it when there is none', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(vi.mocked(submitWorkflow).mock.calls[0][0].body!.metadata).not.toHaveProperty(
      'subjectMeta'
    );
    load.mockResolvedValue(
      new Map([
        [
          7,
          {
            fields: [{ heading: 'Title', text: 'Hello world' }],
            declared: {},
            meta: { messageIds: [3, 2] },
          },
        ],
      ])
    );
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(vi.mocked(submitWorkflow).mock.calls[1][0].body!.metadata).toMatchObject({
      subjectMeta: { messageIds: [3, 2] },
    });
  });

  it('logs one submitted event per successful submit, and none on a failed one', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'text-scan',
        type: 'info',
        message: 'submitted',
        entityType: 'Post',
        entityId: 7,
        mode: 'shadow',
        workflowId: 'wf-1',
      })
    );
    vi.clearAllMocks();
    vi.mocked(submitWorkflow).mockResolvedValue({ data: undefined, error: 'down' } as any);
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'submitted' })
    );
  });

  it('uses the live EM row only in active mode', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(vi.mocked(em.upsert).mock.calls[0][0].where).toEqual({
      entityType_entityId: { entityType: 'Post', entityId: 7 },
    });
    expect(vi.mocked(submitWorkflow).mock.calls[0][0].body!.metadata).toMatchObject({
      emEntityType: 'Post',
      mode: 'active',
    });
  });

  it('never touches the live EM row in shadow mode', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(em.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType_entityId: { entityType: 'Post:shadow', entityId: 7 } },
      })
    );
    expect(vi.mocked(em.upsert).mock.calls[0][0].where).toEqual({
      entityType_entityId: { entityType: 'Post:shadow', entityId: 7 },
    });
    expect(vi.mocked(submitWorkflow).mock.calls[0][0].body!.metadata).toMatchObject({
      emEntityType: 'Post:shadow',
      mode: 'shadow',
    });
  });

  it('writes Pending under the externalId marker BEFORE submitting, keeping the previous verdict', async () => {
    const order: string[] = [];
    em.upsert.mockImplementationOnce(async () => {
      order.push('pending');
      return {} as any;
    });
    vi.mocked(submitWorkflow).mockImplementationOnce(async () => {
      order.push('submit');
      return { data: { id: 'wf-1' } } as any;
    });
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(order).toEqual(['pending', 'submit']);

    const marker = externalIdOf(0);
    const { update, create } = vi.mocked(em.upsert).mock.calls[0][0];
    expect(update).toEqual({
      workflowId: marker,
      contentHash: expect.any(String),
      status: 'Pending',
      retryCount: 0,
    });
    expect(create).toMatchObject({
      entityType: 'Post:shadow',
      entityId: 7,
      workflowId: marker,
      status: 'Pending',
    });
  });

  // A row the retry cron parked at its limit (the entity was not public) must be retried again
  // once a publish rescans it; the cron's own resubmits still count against the limit.
  it('a fresh scan re-arms the retry budget, a retry does not', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7, fromRetry: true });
    expect(vi.mocked(em.upsert).mock.calls[0][0].update).not.toHaveProperty('retryCount');
    expect(vi.mocked(em.upsert).mock.calls[0][0].create).not.toHaveProperty('retryCount');
  });

  it('binds the real workflow id over the marker after submit', async () => {
    await scanEntity({ entityType: 'Post', entityId: 7 });
    expect(em.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'Post:shadow', entityId: 7, workflowId: externalIdOf(0) },
      data: { workflowId: 'wf-1' },
    });
  });

  it.each([
    [
      'no id',
      () =>
        vi.mocked(submitWorkflow).mockResolvedValueOnce({ data: undefined, error: 'boom' } as any),
    ],
    ['throw', () => vi.mocked(submitWorkflow).mockRejectedValueOnce(new Error('network'))],
  ])('marks the marker row Failed when submit returns %s', async (_name, arrange) => {
    arrange();
    expect(await scanEntity({ entityType: 'Post', entityId: 7 })).toEqual({ status: 'failed' });
    expect(em.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'Post:shadow', entityId: 7, workflowId: externalIdOf(0) },
      data: { workflowId: null, status: 'Failed', retryCount: { increment: 1 } },
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', type: 'error', message: 'submit failed' })
    );
  });
});

describe('textScanExternalId', () => {
  it.each([`f${Date.now().toString(36)}`, `8-${Date.now().toString(36)}`])(
    'matches the orchestrator charset and length (attempt %s)',
    (attempt) => {
      const id = textScanExternalId({
        entityType: 'ResourceReview:shadow',
        entityId: 2147483647,
        contentHash: 'a'.repeat(64),
        attempt,
      });
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeLessThanOrEqual(128);
    }
  );
});

describe('scanEntitiesInBackground', () => {
  it('scans every entity, and one that throws does not stop the rest', async () => {
    load.mockImplementation(async ([id]: number[]) => {
      if (id === 1) throw new Error('db down');
      return new Map([[id, { fields: [{ heading: 'Title', text: 'Hello world' }], declared: {} }]]);
    });

    scanEntitiesInBackground('Post', [1, 2, 3]);

    await vi.waitFor(() => expect(submitWorkflow).toHaveBeenCalledTimes(2));
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'background scan threw', entityId: 1 })
    );
  });
});
