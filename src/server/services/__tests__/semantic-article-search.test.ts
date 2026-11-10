import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';

const h = vi.hoisted(() => ({ fetched: [] as number[][] }));

// The feed's fetch path: every id it is asked for comes back, owned by `owner(id)`.
const owner = (id: number) => (id >= 20 ? 7 : id);
vi.mock('~/server/services/article.service', () => ({
  getArticles: async ({ ids }: { ids: number[] }) => {
    h.fetched.push(ids);
    return {
      items: ids.map((id) => ({
        id,
        user: { id: owner(id) },
        coverImage: id === 13 ? undefined : { id: id * 10, tags: [] },
      })),
    };
  },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => ({
    hiddenUsers: [{ id: 901 }],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [
      { id: 801, hidden: true },
      { id: 802, hidden: false },
    ],
  }),
}));

const { searchSemanticArticles, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-article-search.service'
);

// What the site's eligibility re-check reads. Article 11 is unlisted, 12's owner is banned, 14's
// owner is deleted: Qdrant can still propose all three.
const SCHEMA = `
  CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published');
  CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "userId" int NOT NULL REFERENCES "User"(id), unlisted boolean NOT NULL,
    "publishedAt" timestamp(3), status "ArticleStatus" NOT NULL,
    ingestion "ArticleIngestionStatus" NOT NULL, "tosViolation" boolean NOT NULL,
    availability "Availability" NOT NULL
  );
`;
const ELIGIBLE = `now(), 'Published', 'Scanned', false, 'Public'`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  await harness.pg.exec(`
    INSERT INTO "User" VALUES (7, NULL, NULL), (10, NULL, NULL), (11, NULL, NULL),
      (12, now(), NULL), (13, NULL, NULL), (14, NULL, now());
    INSERT INTO "Article" VALUES (10, 10, false, ${ELIGIBLE}), (11, 11, true, ${ELIGIBLE}),
      (12, 12, false, ${ELIGIBLE}), (13, 13, false, ${ELIGIBLE}), (14, 14, false, ${ELIGIBLE});
    INSERT INTO "Article" SELECT g, 7, false, ${ELIGIBLE} FROM generate_series(20, 25) g;
  `);
});
afterAll(() => harness.stop());

let sent: CandidateFilter[];
const ranking =
  (ids: number[]): CandidateSource =>
  async ({ filter, offset, limit }) => {
    sent.push(filter);
    return { ids: ids.slice(offset, offset + limit), correctedQuery: undefined };
  };

beforeEach(() => {
  sent = [];
  h.fetched = [];
  loggingMock.logToAxiom.mockClear();
  dbMock.dbRead.article.findMany.mockImplementation((args: never) =>
    harness.prisma.article.findMany(args)
  );
});

const search = (ids: number[], browsingLevel = 1) =>
  searchSemanticArticles({
    input: { query: 'guide', browsingLevel, limit: 10 },
    candidateSource: ranking(ids),
  });

describe('semantic article search', () => {
  it('re-checks eligibility: never shows an unlisted, banned-owner or deleted-owner article', async () => {
    const { items } = await search([11, 12, 14, 10]);
    expect(items.map((a) => a.id)).toEqual([10]);
    // The feed's fetch path is only asked for what passed the re-check.
    expect(h.fetched).toEqual([[10]]);
  });

  it('keeps rank order, caps one creator per page, and drops an article with no card image', async () => {
    const { items } = await search([20, 13, 21, 10, 22, 23, 24]);
    expect(items.map((a) => a.id)).toEqual([20, 21, 10, 22]);
    expect(items.filter((a) => a.user.id === 7)).toHaveLength(MAX_HITS_PER_USER);
  });

  it("asks the service for the viewer's browsing level, without hidden users or tags", async () => {
    await search([10], 1 | 4);
    expect(sent[0]).toMatchObject({
      gate: { kind: 'level', nsfwLevels: [1, 4] },
      excludedUserIds: [901],
      excludedTagIds: [801],
    });
  });

  it('logs how many candidates came back and how many survived hydration', async () => {
    await search([11, 12, 10]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'semantic-article-search', returned: 3, hydrated: 1 })
    );
  });
});

describe('semantic article search refinements', () => {
  // A refinement that names nothing must narrow to nothing, never fall back to every article.
  const refined = (input: { usernames?: string[]; tagNames?: string[] }) =>
    searchSemanticArticles({
      input: { query: 'guide', browsingLevel: 1, limit: 10, ...input },
      candidateSource: ranking([10]),
    });

  it('returns nothing for a username that does not exist, without asking the service', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
    expect((await refined({ usernames: ['nobody'] })).items).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('returns nothing when any named tag does not exist, without asking the service', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([{ id: 1 }] as never);
    expect((await refined({ tagNames: ['anime', 'missing'] })).items).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('searches with the ids of names that all exist', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 10 }] as never);
    dbMock.dbRead.tag.findMany.mockResolvedValue([{ id: 1 }] as never);
    await refined({ usernames: ['someone'], tagNames: ['anime'] });
    expect(sent[0]).toMatchObject({ userIds: [10], tagIds: [1] });
  });
});
