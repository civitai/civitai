import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The remix-source sweep must audit a source image whose prompt is empty but whose negative prompt
 * is not. It used to skip any image with an empty prompt before reaching the audit, so the negative
 * prompt was never looked at. It now uses `isBlankAuditInput`, the rule the audit itself applies.
 *
 * The REAL `auditPromptEnriched` runs; only I/O and the external classifier are mocked. The
 * classifier is sent the prompt alone, so it must not be called with an empty one.
 */

const { moderatePrompt, chQuery } = vi.hoisted(() => ({
  moderatePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
  chQuery: vi.fn(async () => [{ remixOfId: 101 }]),
}));

vi.mock('~/server/jobs/job', () => ({
  createJob: (_name: string, _cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    name: _name,
    cron: _cron,
    run: () => ({
      result: fn({ checkIfCanceled: () => undefined }),
      cancel: () => Promise.resolve(),
    }),
    options: {},
  }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: chQuery } }));
vi.mock('~/server/integrations/moderation', () => ({ extModeration: { moderatePrompt } }));
vi.mock('~/server/services/post.service', () => ({ bustCachesForPosts: vi.fn() }));

import { auditRemixSourcesJob } from '~/server/jobs/audit-remix-sources';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const findUnique = dbMock.dbRead.image.findUnique;
const update = dbMock.dbWrite.image.update;

const imageWith = (meta: Record<string, unknown>) => ({
  id: 101,
  meta,
  metadata: null,
  userId: 7,
  needsReview: null,
  ingestion: 'Scanned',
});

const runJob = async () => {
  await auditRemixSourcesJob.run({} as never).result;
};

const flaggedForReview = () =>
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 101 }, data: { needsReview: 'remixSource' } })
  );

beforeEach(() => {
  vi.clearAllMocks();
  moderatePrompt.mockImplementation(async () => ({ flagged: false, categories: [] }));
  // Not yet checked in the dedup window, so the sweep reaches the image.
  redisMock.sysRedis.get.mockResolvedValue(null);
  update.mockResolvedValue({ postId: null });
});

describe('audit-remix-sources — empty prompt with a non-empty negative prompt', () => {
  it('control: a celebrity name in the negative prompt is flagged beside a non-empty prompt', async () => {
    findUnique.mockResolvedValue(
      imageWith({ prompt: 'a landscape', negativePrompt: 'tom cruise portrait' })
    );
    await runJob();
    flaggedForReview();
  });

  it('flags a celebrity name in the negative prompt when the prompt is empty', async () => {
    findUnique.mockResolvedValue(imageWith({ prompt: '', negativePrompt: 'tom cruise portrait' }));
    await runJob();
    flaggedForReview();
    expect(moderatePrompt).not.toHaveBeenCalled();
  });

  it('flags it when the prompt is absent', async () => {
    findUnique.mockResolvedValue(imageWith({ negativePrompt: 'tom cruise portrait' }));
    await runJob();
    flaggedForReview();
  });

  it('passes a benign negative prompt without calling the external classifier', async () => {
    findUnique.mockResolvedValue(imageWith({ prompt: '  ', negativePrompt: 'blurry' }));
    await runJob();
    expect(update).not.toHaveBeenCalled();
    expect(moderatePrompt).not.toHaveBeenCalled();
  });

  it('control: a non-empty clean prompt still reaches the external classifier', async () => {
    findUnique.mockResolvedValue(imageWith({ prompt: 'a red fox', negativePrompt: 'blurry' }));
    await runJob();
    expect(moderatePrompt).toHaveBeenCalledWith('a red fox', 'remixAudit');
  });

  it('control: a non-empty prompt with no negative prompt is audited and classified', async () => {
    findUnique.mockResolvedValue(imageWith({ prompt: 'a red fox' }));
    await runJob();
    expect(moderatePrompt).toHaveBeenCalledWith('a red fox', 'remixAudit');
  });

  // Invariant guard: held before the change too.
  it('skips an image whose prompt and negative prompt are both empty', async () => {
    findUnique.mockResolvedValue(imageWith({ prompt: '', negativePrompt: ' ' }));
    await runJob();
    expect(update).not.toHaveBeenCalled();
    expect(moderatePrompt).not.toHaveBeenCalled();
  });
});
