import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as SystemCacheModule from '~/server/services/system-cache';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// The article safety request must stay byte-identical: anything else an article scan asks the model
// (its category) goes in a request of its own. Regenerate the fixture only for a reviewed change to
// the safety prompt or schema.
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
  getCategoryTags: vi.fn(async () => [
    { id: 11, name: 'guide', adminOnly: false },
    { id: 12, name: 'story', adminOnly: false },
  ]),
}));

await import('~/server/services/text-scan/profiles/article.profile');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { submitWorkflow } = await import('@civitai/orchestration-client');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.article.findMany.mockResolvedValue([
    {
      id: 5,
      userId: 9,
      title: 'How I train a LoRA',
      content: '<p>Step one: gather <b>images</b>.</p>',
      userNsfwLevel: 1,
      status: 'Published',
      scheduledAt: null,
    },
  ] as any);
  dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.entityModeration.upsert.mockResolvedValue({} as any);
  dbMock.dbWrite.entityModeration.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as any);
  redisMock.redis.set.mockResolvedValue('OK');
  void loggingMock;
});

describe('article text scan: safety request', () => {
  it('submits the safety workflow exactly as the fixture', async () => {
    await scanEntity({ entityType: 'Article', entityId: 5 });
    const safety = vi
      .mocked(submitWorkflow)
      .mock.calls.map(([call]) => call!.body!)
      .filter((body) => body.tags?.includes('text-scan'));
    expect(safety).toHaveLength(1);
    await expect(JSON.stringify(safety[0], null, 2) + '\n').toMatchFileSnapshot(
      './__fixtures__/article-safety-request.json'
    );
  });
});
