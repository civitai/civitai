import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as SystemCacheModule from '~/server/services/system-cache';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanWebSearchMode: vi.fn(async () => 'off'),
  getTextScanCsamMode: vi.fn(async () => 'review'),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(async () => ({
    base: { id: 1, key: 'base', content: 'BASE PROMPT' },
    'label:nsfw': { id: 78, key: 'label:nsfw', content: 'NSFW DEF' },
    'label:csam': { id: 44, key: 'label:csam', content: 'CSAM DEF' },
  })),
  getTextScanConfig: vi.fn(async () => ({
    model: 'civitai/qwen3.8',
    maxInputChars: 200000,
    maxSegments: 10,
    thinking: false,
  })),
}));
vi.mock('~/server/services/access-token.service', () => ({
  getResourceIdsWithActiveAccessTokens: vi.fn(async () => new Set()),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCacheModule>()),
  getCategoryTags: vi.fn(),
}));

await import('~/server/services/text-scan/profiles/article.profile');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { handleTextCategoryCallback } = await import('~/server/services/text-scan/category');
const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { textScanTextHash, getActiveTextScanPrompts } = await import(
  '~/server/services/text-scan/prompt'
);
const { getTextScanProfile, registerTextScanProfile } = await import(
  '~/server/services/text-scan/profiles'
);
const { getTextScanWebSearchMode } = await import('~/server/services/text-scan/mode');
const { getCategoryTags } = await import('~/server/services/system-cache');
const { submitWorkflow, getWorkflow } = await import('@civitai/orchestration-client');

const ARTICLE = {
  id: 5,
  userId: 9,
  title: 'How I train a LoRA',
  content: '<p>Step one: gather images.</p>',
  userNsfwLevel: 1,
  status: 'Published',
  scheduledAt: null,
};
const CATEGORIES = [
  { id: 11, name: 'guide', adminOnly: false, priority: 1 },
  { id: 12, name: 'story', adminOnly: false, priority: 2 },
  { id: 13, name: 'announcement', adminOnly: true, priority: 3 },
];
const em = dbMock.dbWrite.entityModeration;
const submitted = () => vi.mocked(submitWorkflow).mock.calls.map(([call]) => call!.body!);
const categoryCalls = () => submitted().filter((b) => b.tags?.includes('text-category'));
const writes = () =>
  vi
    .mocked(dbMock.dbWrite.$executeRaw)
    .mock.calls.filter(([sql]) =>
      (sql as TemplateStringsArray).join('?').includes('systemCategoryId')
    );

const writeArgs = () => writes().map(([, ...args]) => args);

let textHash: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(getCategoryTags).mockResolvedValue(CATEGORIES);
  dbMock.dbWrite.article.findMany.mockResolvedValue([ARTICLE] as any);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  em.findUnique.mockResolvedValue(null);
  em.upsert.mockResolvedValue({} as any);
  em.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as any);
  redisMock.redis.set.mockResolvedValue('OK');
  textHash = textScanTextHash((await getTextScanProfile('Article')!.load([5])).get(5)!);
  void loggingMock;
});

describe('scanEntity: the article category call', () => {
  it('submits a category-only workflow offering the pickable categories', async () => {
    const result = await scanEntity({ entityType: 'Article', entityId: 5 });
    expect(result).toEqual({ status: 'submitted', workflowId: 'wf-1' });
    expect(categoryCalls()).toHaveLength(1);
    const [body] = categoryCalls();
    expect(body.tags).toEqual(['text-category', 'Article']);
    expect(body.metadata).toMatchObject({ entityId: 5, categories: ['guide', 'story'], textHash });
    const step = body.steps![0] as any;
    expect(step.input.responseFormat.jsonSchema.schema.properties).toEqual({
      category: { type: 'string', enum: ['guide', 'story'] },
    });
    expect(step.input.messages[0].content).not.toContain('announcement');
    expect(body.callbacks![0].url).toContain('pass=category');
    expect(body.callbacks![0].url).toContain('token=test-webhook-token');
  });

  const isCategoryBody = (arg: unknown) =>
    !!(arg as { body?: { tags?: string[] } }).body?.tags?.includes('text-category');
  it.each([
    [
      'the category list cannot be read',
      () => {
        vi.mocked(getCategoryTags).mockRejectedValue(new Error('redis down'));
      },
    ],
    [
      'the category submit throws',
      () => {
        vi.mocked(submitWorkflow).mockImplementation(async (arg) => {
          if (isCategoryBody(arg)) throw new Error('orchestrator down');
          return { data: { id: 'wf-1' } } as any;
        });
      },
    ],
    [
      'the category submit returns no workflow',
      () => {
        vi.mocked(submitWorkflow).mockImplementation(async (arg) =>
          isCategoryBody(arg)
            ? ({ error: 'bad request' } as any)
            : ({ data: { id: 'wf-1' } } as any)
        );
      },
    ],
  ])('when %s, the scan result and its record are as without it', async (_, fail) => {
    const baseline = await scanEntity({ entityType: 'Article', entityId: 5 });
    const record = () => [em.upsert.mock.calls, em.updateMany.mock.calls];
    const baselineRecord = JSON.stringify(record());
    vi.clearAllMocks();
    em.upsert.mockResolvedValue({} as any);
    em.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as any);
    fail();
    expect(await scanEntity({ entityType: 'Article', entityId: 5 })).toEqual(baseline);
    expect(baseline).toEqual({ status: 'submitted', workflowId: 'wf-1' });
    expect(JSON.stringify(record())).toBe(baselineRecord);
  });

  it('clears the category, and sends no call, when the text is now empty', async () => {
    dbMock.dbWrite.article.findMany.mockResolvedValue([
      { ...ARTICLE, title: '', content: '' },
    ] as any);
    expect(await scanEntity({ entityType: 'Article', entityId: 5 })).toEqual({
      status: 'skipped',
      reason: 'too-short',
    });
    expect(categoryCalls()).toHaveLength(0);
    expect(writeArgs()).toEqual([[null, 5]]);
  });

  it('is sent by the retry cron after a failed first submit', async () => {
    vi.mocked(submitWorkflow).mockResolvedValueOnce({ data: undefined, error: 'down' } as any);
    expect((await scanEntity({ entityType: 'Article', entityId: 5 })).status).not.toBe('submitted');
    expect(categoryCalls()).toHaveLength(0);
    await scanEntity({ entityType: 'Article', entityId: 5, fromRetry: true });
    expect(categoryCalls()).toHaveLength(1);
  });

  it('is not sent for a web-search-only pass', async () => {
    vi.mocked(getTextScanWebSearchMode).mockResolvedValue('active');
    vi.mocked(getActiveTextScanPrompts).mockResolvedValueOnce({
      ...(await getActiveTextScanPrompts()),
      'label:poi': { id: 90, key: 'label:poi', content: 'POI DEF' },
    } as any);
    registerTextScanProfile({
      ...getTextScanProfile('Article')!,
      entityType: 'Model',
      labels: ['poi'],
    });
    const result = await scanEntity({ entityType: 'Model', entityId: 5 });
    expect(submitted().map((b) => b.tags)).toEqual([
      ['text-scan', 'Model', 'active', 'web-search'],
    ]);
    expect(result.status).toBe('submitted');
    expect(categoryCalls()).toHaveLength(0);
  });

  it('is not sent when the scan skipped an unchanged text', async () => {
    await scanEntity({ entityType: 'Article', entityId: 5 });
    const hash = vi.mocked(em.upsert).mock.calls[0][0].create.contentHash;
    vi.mocked(submitWorkflow).mockClear();
    em.findUnique.mockResolvedValue({
      status: 'Succeeded',
      contentHash: hash,
      workflowId: 'wf-1',
      retryCount: 0,
      updatedAt: new Date(),
    } as any);
    expect(await scanEntity({ entityType: 'Article', entityId: 5 })).toEqual({
      status: 'skipped',
      reason: 'unchanged',
    });
    expect(submitted()).toHaveLength(0);
  });
});

function categoryWorkflow(content: string, over: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'wf-cat',
      tags: ['text-category', 'Article'],
      metadata: { entityType: 'Article', entityId: 5, textHash, categories: ['guide', 'story'] },
      steps: [{ $type: 'chatCompletion', output: { choices: [{ message: { content } }] } }],
      ...over,
    },
  } as any;
}
const callback = (status = 'succeeded') =>
  handleTextCategoryCallback({ workflowId: 'wf-cat', status });

describe('handleTextCategoryCallback', () => {
  it('writes the chosen category tag id', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(categoryWorkflow('{"category":"story"}'));
    await callback();
    expect(writeArgs()).toEqual([[12, 5]]);
    const sql = (writes()[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/UPDATE "Article" SET "systemCategoryId" = \? WHERE id = \?/);
    expect(sql).not.toContain('TagsOnArticle');
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['a name it was not offered', '{"category":"announcement"}'],
    ['no category', '{"nsfw":{"level":"none"}}'],
  ])('clears the category for %s', async (_, content) => {
    vi.mocked(getWorkflow).mockResolvedValue(categoryWorkflow(content));
    await callback();
    expect(writeArgs()).toEqual([[null, 5]]);
  });

  it('writes nothing when the text changed after submit', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(categoryWorkflow('{"category":"story"}'));
    dbMock.dbWrite.article.findMany.mockResolvedValue([{ ...ARTICLE, title: 'Edited' }] as any);
    await callback();
    expect(writes()).toHaveLength(0);
  });

  it('clears the category for a failed workflow', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(categoryWorkflow('{"category":"story"}'));
    await callback('failed');
    expect(writeArgs()).toEqual([[null, 5]]);
  });

  it('a failing write resolves and never touches the scan record', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(categoryWorkflow('{"category":"story"}'));
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('column does not exist'));
    await expect(callback()).resolves.toBeUndefined();
    expect(em.upsert).not.toHaveBeenCalled();
    expect(em.updateMany).not.toHaveBeenCalled();
  });

  it('clears the category for an article that is no longer public', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(categoryWorkflow('{"category":"story"}'));
    dbMock.dbWrite.article.findMany.mockResolvedValue([{ ...ARTICLE, status: 'Draft' }] as any);
    await callback();
    expect(writeArgs()).toEqual([[null, 5]]);
  });

  it('clears the category when the chosen one became adminOnly after submit', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(categoryWorkflow('{"category":"story"}'));
    vi.mocked(getCategoryTags).mockResolvedValue(
      CATEGORIES.map((c) => (c.name === 'story' ? { ...c, adminOnly: true } : c))
    );
    await callback();
    expect(writeArgs()).toEqual([[null, 5]]);
  });

  it('writes nothing for a workflow without the text-category tag', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      categoryWorkflow('{"category":"story"}', { tags: ['text-scan', 'Article'] })
    );
    await callback();
    expect(writes()).toHaveLength(0);
  });

  it('a category workflow sent to the scan callback is ignored there', async () => {
    const workflow = categoryWorkflow('{"category":"story"}');
    // A mode, so the scan callback's own tag check is what turns it away.
    workflow.data.metadata = { ...workflow.data.metadata, mode: 'active' };
    vi.mocked(getWorkflow).mockResolvedValue(workflow);
    await handleTextScanCallback({ workflowId: 'wf-cat', status: 'failed' });
    expect(em.upsert).not.toHaveBeenCalled();
    expect(em.updateMany).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });
});
