import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  pg: null as null | PGlite,
  // What the feed's read returns per id: its own gates and cover are tested with the feed.
  cards: new Map<number, { userId: number; status: string }>(),
  feedCalls: [] as Record<string, unknown>[],
  includesInappropriate:
    vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | 'poi' | false>(),
  evalBoolean: vi.fn<() => { enabled: unknown }>(),
  fliptClient: null as null | { evaluateBoolean: () => { enabled: unknown } },
}));

vi.mock('~/server/services/storyline.service', () => ({
  getStorylinesInfinite: async (args: { ids: number[] }) => {
    h.feedCalls.push(args);
    return {
      items: args.ids.flatMap((id) => {
        const card = h.cards.get(id);
        return card
          ? [{ id, status: card.status, user: { id: card.userId }, coverImage: { id: id * 1000 } }]
          : [];
      }),
    };
  },
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureFliptInitialized: async () => undefined,
  getFliptClientSync: () => h.fliptClient,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/utils/metadata/audit', () => ({
  includesInappropriate: h.includesInappropriate,
  includesPoi: () => false,
  includesMinor: () => false,
}));
vi.mock('~/server/services/system-cache', () => ({ getBrowsingSettingAddons: async () => [] }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => ({
    hiddenUsers: [{ id: 901 }],
    blockedUsers: [{ id: 902 }],
    blockedByUsers: [],
    hiddenTags: [],
  }),
}));

const { searchSemanticStorylines, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-storyline-search.service'
);

const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp);
  CREATE TABLE "Storyline" (id int PRIMARY KEY, "userId" int, "tosViolation" boolean DEFAULT false,
    "maxNsfwLevel" int DEFAULT 16, "nsfwLevel" int DEFAULT 0, "moderatorNsfwLevel" int,
    "minorByScan" boolean DEFAULT false);
  CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int, "tosViolation" boolean DEFAULT false,
    "nsfwLevel" int, "publishedAt" timestamp, availability text DEFAULT 'Public');
  CREATE TABLE "StorylineChapter" (id int PRIMARY KEY, "storylineId" int, "postId" int, depth int,
    "removedAt" timestamp);
  CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "postId" int, "needsReview" text,
    "blockedFor" text, "nsfwLevel" int DEFAULT 1, minor boolean DEFAULT false,
    "acceptableMinor" boolean DEFAULT false);
  CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean DEFAULT false);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "EvidenceHeldUser" ("userId" int);
  CREATE TABLE "PostText" (id serial PRIMARY KEY, "postId" int, "csamHeld" boolean NOT NULL);
  CREATE TABLE "TextScanHold" (id serial PRIMARY KEY, "entityType" text, "entityId" int,
    label text, status text);
`;

const { PG, R } = NsfwLevel;

/**
 * An eligible storyline `id` owned by `owner`: chapter 1 is post `id * 10`, by the owner unless
 * `author` is given, published `published` ago (negative: scheduled), with image `id * 100`.
 */
async function storyline(
  id: number,
  {
    owner = id,
    author = owner,
    level = PG,
    published = '1 day',
    status = 'Ongoing',
  }: { owner?: number; author?: number; level?: number; published?: string; status?: string } = {}
) {
  for (const u of new Set([owner, author]))
    await h.pg!.query(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [u]);
  await h.pg!.query(`INSERT INTO "Storyline" (id, "userId") VALUES ($1, $2)`, [id, owner]);
  await h.pg!.query(
    `INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt")
     VALUES ($1, $2, $3, LOCALTIMESTAMP - $4::interval)`,
    [id * 10, author, level, published]
  );
  await h.pg!.query(
    `INSERT INTO "StorylineChapter" (id, "storylineId", "postId", depth) VALUES ($1, $1, $2, 0)`,
    [id, id * 10]
  );
  await h.pg!.query(`INSERT INTO "Image" (id, "userId", "postId") VALUES ($1, $2, $3)`, [
    id * 100,
    author,
    id * 10,
  ]);
  h.cards.set(id, { userId: owner, status });
}

let sent: CandidateFilter[];
const ranking =
  (ids: number[], correctedQuery?: string): CandidateSource =>
  async ({ filter, offset, limit }) => {
    sent.push(filter);
    return { ids: ids.slice(offset, offset + limit), correctedQuery };
  };

const MOD = { id: 501, isModerator: true } as SessionUser;
const search = (
  ids: number[],
  {
    browsingLevel = PG,
    user,
    status,
    correctedQuery,
  }: {
    browsingLevel?: number;
    user?: SessionUser;
    status?: 'Ongoing' | 'Complete';
    correctedQuery?: string;
  } = {}
) =>
  searchSemanticStorylines({
    input: { query: 'dragon heist', browsingLevel, status, limit: 10 },
    user,
    candidateSource: ranking(ids, correctedQuery),
  });
const shown = (r: { items: { id: number }[] }) => r.items.map((s) => s.id);

beforeAll(async () => {
  h.pg = new PGlite();
});

beforeEach(async () => {
  await h.pg!.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; ${SCHEMA}`);
  // The eligibility read runs as written, against a Postgres stand-in.
  dbMock.dbRead.$queryRaw.mockReset().mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...values);
    return (await h.pg!.query(sql.text, sql.values)).rows;
  }) as never);
  sent = [];
  h.cards = new Map();
  h.feedCalls = [];
  h.includesInappropriate.mockReset().mockReturnValue(false);
  h.evalBoolean.mockReset().mockReturnValue({ enabled: true });
  h.fliptClient = { evaluateBoolean: () => h.evalBoolean() };
  loggingMock.logToAxiom.mockClear();
});

describe('semantic storyline search', () => {
  it("asks only for chapter 1 published by now, at the viewer's levels, without hidden creators", async () => {
    const before = Date.now();
    await search([], { browsingLevel: PG | R, user: MOD, status: 'Complete' });
    expect(sent[0]).toMatchObject({
      gate: { kind: 'level', nsfwLevels: [PG, R] },
      excludedUserIds: [901, 902],
      anyOf: { status: ['Complete'] },
      range: { key: 'rootPublishedAt' },
    });
    const cutoff = Date.parse(String(sent[0].range?.lte));
    expect(cutoff).toBeGreaterThanOrEqual(before - 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(sent[0].range?.gte).toBeUndefined();
  });

  it('sends the same cutoff and gate on every page of one search, though time passes', async () => {
    for (let id = 1; id <= 40; id++) await storyline(id, { owner: 7 });
    // Only Date is faked, so Postgres still runs; each page is asked for a minute after the last.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const pages = ranking(Array.from({ length: 40 }, (_, i) => i + 1));
      await searchSemanticStorylines({
        input: { query: 'dragon heist', browsingLevel: PG, limit: 10 },
        candidateSource: async (args) => {
          const page = await pages(args);
          vi.setSystemTime(Date.now() + 60_000);
          return page;
        },
      });
    } finally {
      vi.useRealTimers();
    }
    expect(sent.length).toBeGreaterThan(1);
    for (const f of sent) {
      expect(f.range).toEqual(sent[0].range);
      expect(f.gate).toEqual(sent[0].gate);
    }
  });

  it('serves an eligible storyline through the feed read, in rank order, with its cover', async () => {
    await storyline(1);
    await storyline(2);
    const result = await search([2, 1], { user: { id: 44 } as SessionUser });
    expect(shown(result)).toEqual([2, 1]);
    expect(result.items[0].coverImage).toEqual({ id: 2000 });
    // The feed applies the viewer's view: their hidden creators, and the cover's own gate.
    expect(h.feedCalls[0]).toMatchObject({
      ids: [2, 1],
      viewer: { id: 44 },
      browsingLevel: PG,
    });
  });

  it('does not serve a storyline whose chapter 1 is scheduled, though its point is indexed', async () => {
    await storyline(1);
    await storyline(2, { published: '-1 hour' });
    expect(shown(await search([2, 1]))).toEqual([1]);
    expect(h.feedCalls).toEqual([expect.objectContaining({ ids: [1] })]);
  });

  it("does not serve a held owner's or held chapter-1 author's storyline", async () => {
    await storyline(1);
    await storyline(2, { owner: 77 });
    await storyline(3, { owner: 3, author: 78 });
    await storyline(4);
    await h.pg!.exec(`INSERT INTO "EvidenceHeldUser" VALUES (77);
      INSERT INTO "CsamReport" ("userId") VALUES (78);
      UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 400;`);
    expect(shown(await search([4, 3, 2, 1]))).toEqual([1]);
  });

  it('does not serve a storyline that lost eligibility since it was indexed', async () => {
    for (const id of [1, 2, 3, 4, 5]) await storyline(id);
    await h.pg!.exec(`
      UPDATE "User" SET "bannedAt" = now() WHERE id = 2;
      UPDATE "Storyline" SET "tosViolation" = true WHERE id = 3;
      UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 4;
      UPDATE "Post" SET availability = 'Private' WHERE id = 50;`);
    expect(shown(await search([5, 4, 3, 2, 1]))).toEqual([1]);
  });

  it("re-checks the story's level against the viewer's: chapter 1's, raised to the title's", async () => {
    await storyline(1);
    await storyline(2, { level: R });
    await storyline(3);
    await h.pg!.exec(`UPDATE "Storyline" SET "moderatorNsfwLevel" = ${R} WHERE id = 3`);
    expect(shown(await search([3, 2, 1], { browsingLevel: PG }))).toEqual([1]);
    expect(shown(await search([3, 2, 1], { browsingLevel: PG | R, user: MOD }))).toEqual([3, 2, 1]);
  });

  it('honours the status filter and caps one creator per page', async () => {
    await storyline(1, { status: 'Complete' });
    for (const id of [10, 11, 12, 13]) await storyline(id, { owner: 7, status: 'Complete' });
    await storyline(20);
    const result = await search([1, 10, 11, 12, 13, 20], { status: 'Complete' });
    expect(shown(result)).toEqual([1, 10, 11, 12]);
    expect(result.items.filter((s) => s.user.id === 7)).toHaveLength(MAX_HITS_PER_USER);
  });

  it("narrows a non-moderator's minor query to the safe levels, gate and re-check both", async () => {
    // The containment clamp lifted, so the viewer's own R level is what the verdict narrows.
    h.evalBoolean.mockReturnValue({ enabled: false });
    await storyline(1);
    await storyline(2, { level: R });
    const viewer = { id: 500, isModerator: false } as SessionUser;
    expect(shown(await search([2, 1], { browsingLevel: PG | R, user: viewer }))).toEqual([2, 1]);
    expect(sent[0].gate).toMatchObject({ nsfwLevels: [PG, R] });

    sent = [];
    h.includesInappropriate.mockReturnValue('minor');
    expect(shown(await search([2, 1], { browsingLevel: PG | R, user: viewer }))).toEqual([1]);
    expect(sent[0].gate).toMatchObject({ nsfwLevels: expect.not.arrayContaining([R]) });
  });

  it('refuses a refused query before asking the index', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    await storyline(1);
    expect(shown(await search([1], { user: MOD }))).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("returns nothing when the service's spelling correction is refused", async () => {
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'poi' : false
    );
    await storyline(1);
    expect(shown(await search([1], { correctedQuery: 'corrected' }))).toEqual([]);
    expect(shown(await search([1], { correctedQuery: 'fine' }))).toEqual([1]);
  });
});
