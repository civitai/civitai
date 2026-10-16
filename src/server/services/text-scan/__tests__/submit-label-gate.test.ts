import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import type * as ModeModule from '~/server/services/text-scan/mode';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';

// @civitai/client is mocked globally in src/__tests__/setup.ts (submitWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanWebSearchMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));

const { scanEntity } = await import('~/server/services/text-scan/submit');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { resetTextScanRolloutCache } = await import('~/server/services/text-scan/mode');
const { submitWorkflow } = await import('@civitai/client');
const { getActiveTextScanPrompts, getTextScanConfig } = await import(
  '~/server/services/text-scan/prompt'
);

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE' },
  'label:scam': { id: 6, key: 'label:scam', content: 'SCAM DEF' },
};
const CSAM_PROMPT = { 'label:csam': { id: 7, key: 'label:csam', content: 'CSAM DEF' } };
const load = async (ids: number[]) =>
  new Map(
    ids.map((id) => [id, { fields: [{ heading: 'Body', text: 'placeholder text' }], declared: {} }])
  );

const em = dbMock.dbWrite.entityModeration;
const lastBody = () =>
  vi.mocked(submitWorkflow).mock.calls.at(-1)![0].body as unknown as {
    metadata: { labels: string[]; promptIds: Record<string, number> };
    steps: { input: { messages: { content: string }[] } }[];
  };
const lastHash = () =>
  (em.upsert.mock.calls.at(-1)![0].create as { contentHash: string }).contentHash;

function csamMode(value: string | undefined) {
  redisMock.sysRedis.hGetAll.mockResolvedValue((value ? { csam: value } : {}) as never);
  resetTextScanRolloutCache();
}

/** The hash a profile without csam submits with: what every row carries before the gate opens. */
async function baselineHash() {
  registerTextScanProfile({ entityType: 'Comment', labels: ['scam'], load });
  await scanEntity({ entityType: 'Comment', entityId: 3 });
  registerTextScanProfile({ entityType: 'Comment', labels: ['scam', 'csam'], load });
  return lastHash();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue({
    model: 'air:test',
    maxInputChars: 1000,
    thinking: false,
  });
  em.findUnique.mockResolvedValue(null);
  em.upsert.mockResolvedValue({} as never);
  em.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as never);
  csamMode(undefined);
});

describe('the csam gate at submit time', () => {
  it('drops csam while off: no csam prompt needed and the hash is the pre-gate hash', async () => {
    const before = await baselineHash();
    expect(await scanEntity({ entityType: 'Comment', entityId: 3 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
    expect(lastBody().metadata.promptIds).toEqual({ base: 1, scam: 6 });
    expect(lastHash()).toBe(before);
  });

  it('treats an unparseable or unreadable gate as off', async () => {
    const before = await baselineHash();
    csamMode('auto');
    expect(await scanEntity({ entityType: 'Comment', entityId: 3 })).toMatchObject({
      status: 'submitted',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
    redisMock.sysRedis.hGetAll.mockRejectedValue(new Error('down'));
    resetTextScanRolloutCache();
    expect(await scanEntity({ entityType: 'Comment', entityId: 3 })).toMatchObject({
      status: 'submitted',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
    expect(lastHash()).toBe(before);
  });

  it('skips a row already scanned before the gate existed while csam stays off', async () => {
    const before = await baselineHash();
    em.findUnique.mockResolvedValue({
      status: 'Succeeded',
      contentHash: before,
      workflowId: 'wf-old',
      retryCount: 0,
      updatedAt: new Date(),
    } as never);
    expect(await scanEntity({ entityType: 'Comment', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'unchanged',
    });
  });

  it('asks for csam in review, with a new hash, so that row is rescanned once', async () => {
    const before = await baselineHash();
    em.findUnique.mockResolvedValue({
      status: 'Succeeded',
      contentHash: before,
      workflowId: 'wf-old',
      retryCount: 0,
      updatedAt: new Date(),
    } as never);
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({ ...PROMPTS, ...CSAM_PROMPT });
    csamMode('review');
    expect(await scanEntity({ entityType: 'Comment', entityId: 3 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(lastBody().metadata.labels).toEqual(['scam', 'csam']);
    expect(lastBody().steps[0].input.messages[0].content).toContain('CSAM DEF');
    expect(lastHash()).not.toBe(before);
  });
});
