import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Job from '~/server/jobs/job';
import type * as TagsOnImageNew from '~/server/services/tagsOnImageNew.service';

const { mockUpsert } = vi.hoisted(() => ({ mockUpsert: vi.fn() }));

vi.mock('~/server/jobs/job', async (importOriginal) => ({
  ...(await importOriginal<typeof Job>()),
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
  getJobDate: vi.fn().mockResolvedValue([new Date(0), vi.fn()]),
}));
vi.mock('~/server/services/tagsOnImageNew.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagsOnImageNew>()),
  insertTagsOnImageNew: vi.fn(),
  upsertTagsOnImageNew: mockUpsert,
  deleteTagsOnImageNew: vi.fn(),
}));

import { applyVotedTags } from '~/server/jobs/apply-voted-tags';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { deleteTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyVotedTags — moderator upvote on a disabled tag', () => {
  it('re-enables the disabled tag, not the newly applied ones', async () => {
    const queries = vi.mocked(dbMock.dbWrite.$queryRaw);
    queries
      .mockResolvedValueOnce([{ imageId: 1, tagId: 11 }] as never) // newly over threshold
      .mockResolvedValueOnce([{ imageId: 2, tagId: 22 }] as never); // disabled, mod-upvoted

    await applyVotedTags.run({} as never);

    expect(mockUpsert).toHaveBeenCalledWith([{ imageId: 2, tagId: 22, disabled: false }]);
    expect(mockUpsert).not.toHaveBeenCalledWith([{ imageId: 1, tagId: 11, disabled: false }]);
  });
});

describe('applyVotedTags — downvotes on child browsing tags (PGlite)', () => {
  const CHILD_TAG = 5351;
  const LABEL_TAG = 900;
  const OWNER_VOTE = -3;
  const MOD_VOTE = -10;

  let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
  beforeAll(async () => {
    harness = await startPglitePrisma(`
      CREATE FUNCTION iif(boolean, int, int) RETURNS int AS 'SELECT CASE WHEN $1 THEN $2 ELSE $3 END' LANGUAGE sql;
      CREATE TABLE "Tag" (id int PRIMARY KEY, type text NOT NULL);
      CREATE TABLE "TagsOnImageDetails" (
        "imageId" int, "tagId" int, automated boolean NOT NULL DEFAULT true,
        disabled boolean NOT NULL DEFAULT false, "needsReview" boolean NOT NULL DEFAULT false,
        PRIMARY KEY ("imageId", "tagId")
      );
      CREATE TABLE "TagsOnImageVote" (
        "userId" int, "tagId" int, "imageId" int, vote int NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT now(), applied boolean NOT NULL DEFAULT false,
        PRIMARY KEY ("userId", "tagId", "imageId")
      );
      INSERT INTO "Tag" VALUES (${CHILD_TAG}, 'Label'), (${LABEL_TAG}, 'Label');
    `);
    const { prisma } = harness;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
      ...args: Parameters<typeof prisma.$queryRaw>
    ) => prisma.$queryRaw(...args)) as never);
    vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(((
      ...args: Parameters<typeof prisma.$executeRaw>
    ) => prisma.$executeRaw(...args)) as never);
  }, 60_000);
  afterAll(async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async () => []) as never);
    vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async () => 0) as never);
    await harness.stop();
  });
  beforeEach(async () => {
    await harness.pg.exec('DELETE FROM "TagsOnImageVote"; DELETE FROM "TagsOnImageDetails";');
  });

  async function seed(tagId: number, vote: number) {
    await harness.pg.exec(`
      INSERT INTO "TagsOnImageDetails" ("imageId", "tagId") VALUES (1, ${tagId});
      INSERT INTO "TagsOnImageVote" ("userId", "tagId", "imageId", vote) VALUES (7, ${tagId}, 1, ${vote});
    `);
  }
  const deleted = () => vi.mocked(deleteTagsOnImageNew).mock.calls.flatMap(([rows]) => rows);
  const disabled = () =>
    mockUpsert.mock.calls.flatMap(([rows]) => rows).filter((row) => row.disabled === true);

  it("keeps a child tag the image's owner downvoted", async () => {
    await seed(CHILD_TAG, OWNER_VOTE);
    await applyVotedTags.run({} as never);
    expect(deleted()).toEqual([]);
    expect(disabled()).toEqual([]);
  });

  it('still deletes any other automated tag the owner downvoted', async () => {
    await seed(LABEL_TAG, OWNER_VOTE);
    await applyVotedTags.run({} as never);
    expect(deleted()).toEqual([{ imageId: 1, tagId: LABEL_TAG }]);
  });

  it('disables a child tag a moderator downvoted', async () => {
    await seed(CHILD_TAG, MOD_VOTE);
    await applyVotedTags.run({} as never);
    expect(deleted()).toEqual([]);
    expect(disabled()).toEqual([
      { imageId: 1, tagId: CHILD_TAG, disabled: true, needsReview: false },
    ]);
  });
});
