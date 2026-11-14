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
  // The feed card of each id, as getModel3DFeedItemsByIds reads it: owner and tags.
  cards: new Map<number, { userId: number; tags: number[] }>(),
  fetched: [] as number[][],
  includesInappropriate:
    vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | 'poi' | false>(),
  evalBoolean: vi.fn<() => { enabled: unknown }>(),
  fliptClient: null as null | { evaluateBoolean: () => { enabled: unknown } },
}));

vi.mock('~/server/services/model3d.service', () => ({
  getModel3DFeedItemsByIds: async ({ ids }: { ids: number[] }) => {
    h.fetched.push(ids);
    return ids.flatMap((id) => (h.cards.has(id) ? [{ id, ...h.cards.get(id)! }] : []));
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
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [{ id: 66, hidden: true }],
  }),
}));

const { searchSemanticModels3D, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-model3d-search.service'
);

const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp);
  CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, ingestion text, "needsReview" text,
    "tosViolation" boolean DEFAULT false, "blockedFor" text, "nsfwLevel" int,
    minor boolean DEFAULT false, poi boolean DEFAULT false, "acceptableMinor" boolean DEFAULT false);
  CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean DEFAULT false);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "EvidenceHeldUser" ("userId" int);
  CREATE TABLE "Model3D" (id int PRIMARY KEY, "userId" int, "thumbnailImageId" int, status text,
    "deletedAt" timestamp, "nsfwLevel" int, "tosViolation" boolean DEFAULT false,
    unlisted boolean DEFAULT false, minor boolean DEFAULT false, poi boolean DEFAULT false,
    availability text DEFAULT 'Public');
`;

const { PG, R } = NsfwLevel;

/** An eligible 3D model `id` with its own scanned thumbnail `id * 10`, and its feed card. */
async function model(
  id: number,
  { owner = id, level = PG, thumb = level, tags = [] as number[] } = {}
) {
  await h.pg!.query(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [owner]);
  await h.pg!.query(
    `INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel") VALUES ($1, $2, 'Scanned', $3)`,
    [id * 10, owner, thumb]
  );
  await h.pg!.query(
    `INSERT INTO "Model3D" (id, "userId", "thumbnailImageId", status, "nsfwLevel")
     VALUES ($1, $2, $3, 'Published', $4)`,
    [id, owner, id * 10, level]
  );
  h.cards.set(id, { userId: owner, tags });
}

let sent: CandidateFilter[];
const ranking =
  (ids: number[]): CandidateSource =>
  async ({ filter, offset, limit }) => {
    sent.push(filter);
    return { ids: ids.slice(offset, offset + limit) };
  };

const MOD = { id: 501, isModerator: true } as SessionUser;
const search = (
  ids: number[],
  {
    browsingLevel = PG,
    user,
    tagIds,
  }: { browsingLevel?: number; user?: SessionUser; tagIds?: number[] } = {}
) =>
  searchSemanticModels3D({
    input: { query: 'robot', browsingLevel, tagIds, limit: 10 },
    user,
    candidateSource: ranking(ids),
  });
const shown = (r: { items: { id: number }[] }) => r.items.map((m) => m.id);

beforeAll(async () => {
  h.pg = new PGlite();
});

beforeEach(async () => {
  // The eligibility read runs as written, against a Postgres stand-in.
  dbMock.dbRead.$queryRaw.mockReset().mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...values);
    return (await h.pg!.query(sql.text, sql.values)).rows;
  }) as never);
  await h.pg!.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; ${SCHEMA}`);
  sent = [];
  h.cards = new Map();
  h.fetched = [];
  h.includesInappropriate.mockReset().mockReturnValue(false);
  h.evalBoolean.mockReset().mockReturnValue({ enabled: true });
  h.fliptClient = { evaluateBoolean: () => h.evalBoolean() };
  loggingMock.logToAxiom.mockClear();
});

describe('semantic 3D model search', () => {
  it("asks for the viewer's levels, without hidden creators and tags", async () => {
    await search([], { browsingLevel: PG | R, user: MOD, tagIds: [5] });
    expect(sent[0]).toMatchObject({
      gate: { kind: 'level', nsfwLevels: [PG, R] },
      tagIds: [5],
      excludedUserIds: [901],
      excludedTagIds: [66],
    });
  });

  it('serves an eligible model, in rank order', async () => {
    await model(1);
    await model(2);
    expect(shown(await search([2, 1]))).toEqual([2, 1]);
  });

  it("does not serve a held owner's model whose point is still in the index", async () => {
    await model(1);
    await model(2, { owner: 77 });
    await model(3, { owner: 78 });
    await h.pg!.exec(`INSERT INTO "EvidenceHeldUser" VALUES (77);
      INSERT INTO "CsamReport" ("userId") VALUES (78);`);
    expect(shown(await search([3, 2, 1]))).toEqual([1]);
    // Dropped before the card read, so nothing of theirs is fetched.
    expect(h.fetched).toEqual([[1]]);
  });

  it('does not serve a model that lost eligibility since it was indexed', async () => {
    for (const id of [1, 2, 3, 4, 5]) await model(id);
    await h.pg!.exec(`
      UPDATE "User" SET "bannedAt" = now() WHERE id = 2;
      UPDATE "Model3D" SET status = 'Unpublished' WHERE id = 3;
      UPDATE "Image" SET "needsReview" = 'poi' WHERE id = 40;
      UPDATE "Model3D" SET "thumbnailImageId" = NULL WHERE id = 5;`);
    expect(shown(await search([5, 4, 3, 2, 1]))).toEqual([1]);
  });

  it("re-checks the model's and the thumbnail's level against the viewer's", async () => {
    await model(1);
    // Each rated apart: the model above the viewer's level, then only its thumbnail.
    await model(2, { level: R, thumb: PG });
    await model(3, { level: PG, thumb: R });
    expect(shown(await search([3, 2, 1], { browsingLevel: PG }))).toEqual([1]);
    expect(shown(await search([3, 2, 1], { browsingLevel: PG | R, user: MOD }))).toEqual([3, 2, 1]);
  });

  it('drops hidden creators and tags, honours the tag filter, and caps one creator', async () => {
    await model(1, { owner: 901 });
    await model(2, { tags: [66] });
    await model(3, { tags: [5] });
    for (const id of [10, 11, 12, 13]) await model(id, { owner: 7, tags: [5] });
    expect(shown(await search([1, 2, 3, 10, 11, 12, 13]))).toEqual([3, 10, 11, 12]);
    expect(MAX_HITS_PER_USER).toBe(3);
    await model(20);
    expect(shown(await search([20, 3], { tagIds: [5] }))).toEqual([3]);
  });

  it('searches a minor query at the safe levels only, gate and re-check both', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    await model(1);
    await model(2, { thumb: R });
    const viewer = { id: 500, isModerator: false } as SessionUser;
    expect(shown(await search([2, 1], { browsingLevel: PG | R, user: viewer }))).toEqual([1]);
    expect(sent[0].gate).toMatchObject({ nsfwLevels: expect.not.arrayContaining([R]) });
  });
});
