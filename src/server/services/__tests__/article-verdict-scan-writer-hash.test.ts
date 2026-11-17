import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as AdaptersModule from '~/server/services/moderation-adapters';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as PromptModule from '~/server/services/text-scan/prompt';

// The textHash a text-scan verdict stores is the one the recompute compares: the article profile,
// scanEntity and the callback that records the verdict all run. Only the orchestrator round trip,
// the scan's settings and the db are stubbed.

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanWebSearchMode: vi.fn(async () => 'off'),
  getTextScanCsamMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(async () => ({
    base: { id: 1, key: 'base', content: 'BASE PROMPT' },
    'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
  })),
  getTextScanConfig: vi.fn(async () => ({
    model: 'air:test',
    maxInputChars: 10_000,
    maxSegments: 10,
    thinking: false,
  })),
}));
// The verdict is recorded before any adapter runs; what the article adapter does with it is not
// under test here.
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof AdaptersModule>()),
  getModerationAdapter: vi.fn(() => undefined),
}));

const { getWorkflow, submitWorkflow } = await import('@civitai/orchestration-client');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
await import('~/server/services/text-scan/profiles/article.profile');
const { ARTICLE_TEXT_VERDICT_HASHED_SINCE, articleTextVerdictMatch } = await import(
  '~/server/services/article.service'
);

const ARTICLE = 71;
const TITLE = 'Title';
const NEW = { title: TITLE, content: '<p>New body</p>' };

let storedArticle = NEW;
const CLEAN = { nsfw: { level: 'none', reason: 'Nothing sexual.' } };

/** Scan the article as stored, deliver the orchestrator's callback, and return the row written. */
async function scanAndRecord() {
  expect(await scanEntity({ entityType: 'Article', entityId: ARTICLE })).toMatchObject({
    status: 'submitted',
  });
  const body = vi.mocked(submitWorkflow).mock.calls.at(-1)?.[0]?.body;
  vi.mocked(getWorkflow).mockResolvedValue({
    data: {
      metadata: body!.metadata,
      tags: body!.tags,
      steps: [
        {
          $type: 'chatCompletion',
          output: {
            choices: [{ message: { content: JSON.stringify(CLEAN) }, finishReason: 'stop' }],
            parsed: CLEAN,
          },
        },
      ],
    },
  } as never);
  await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
  const recorded = dbMock.dbWrite.entityModeration.updateMany.mock.calls
    .map(([args]) => (args as { data: { status?: string; result?: unknown } }).data)
    .find((data) => data.status === 'Succeeded');
  expect(recorded, 'the callback recorded a verdict').toBeDefined();
  return {
    contentHash: 'composite-of-prompt-model-and-text',
    result: recorded!.result as never,
    updatedAt: new Date(ARTICLE_TEXT_VERDICT_HASHED_SINCE.getTime() + 24 * 60 * 60 * 1000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storedArticle = NEW;
  dbMock.dbWrite.article.findMany.mockImplementation((async () => [
    {
      id: ARTICLE,
      userId: 7,
      ...storedArticle,
      userNsfwLevel: 1,
      status: 'Published',
      scheduledAt: null,
    },
  ]) as never);
  dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(null as never);
  dbMock.dbWrite.entityModeration.upsert.mockResolvedValue({} as never);
  dbMock.dbWrite.entityModeration.updateMany.mockResolvedValue({ count: 1 } as never);
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as never);
  redisMock.redis.set.mockResolvedValue('OK' as never);
});

describe('the textHash a text-scan verdict stores for an article', () => {
  it('matches the text the article has', async () => {
    const verdict = await scanAndRecord();
    expect(articleTextVerdictMatch(verdict, NEW)).toBe('current');
  });

  it('positive control: a verdict recorded for other text does not match', async () => {
    storedArticle = { title: TITLE, content: '<p>Other body</p>' };
    const verdict = await scanAndRecord();
    expect(articleTextVerdictMatch(verdict, NEW)).toBe('other');
  });
});
