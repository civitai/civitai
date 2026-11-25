import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
import { describeSemanticAuditContract } from './semantic-audit.harness';

const h = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  pg: null as null | PGlite,
  // The feed card of each id, as getAllCollectionsInfiniteHandler reads it: owner and type.
  cards: new Map<number, { userId: number; type: string | null }>(),
  fetched: [] as number[][],
  includesInappropriate:
    vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | 'poi' | false>(),
  evalBoolean: vi.fn<() => { enabled: unknown }>(),
  fliptClient: null as null | { evaluateBoolean: () => { enabled: unknown } },
}));

vi.mock('~/server/services/semantic-search-audit.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordSemanticAudit: h.recordAudit,
  recordRefusedSemanticAudit: h.recordAudit,
}));
vi.mock('~/server/controllers/collection.controller', () => ({
  getAllCollectionsInfiniteHandler: async ({ input }: { input: { ids: number[] } }) => {
    h.fetched.push(input.ids);
    return {
      items: input.ids.flatMap((id) => (h.cards.has(id) ? [{ id, ...h.cards.get(id)! }] : [])),
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
vi.mock('~/server/services/search-query-rules', () => ({ matchesQueryRule: async () => false }));
vi.mock('~/utils/metadata/audit', () => ({
  includesNsfw: () => false,
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

const { searchSemanticCollections, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-collection-search.service'
);

const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int, read text DEFAULT 'Public',
    availability text DEFAULT 'Public', "nsfwLevel" int, type text);
  CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int,
    status text DEFAULT 'ACCEPTED');
`;

const { PG, R } = NsfwLevel;

/** An eligible collection `id` with one accepted item, and its feed card. */
async function collection(
  id: number,
  {
    owner = id,
    level = PG,
    type = 'Image',
  }: { owner?: number; level?: number; type?: string | null } = {}
) {
  await h.pg!.query(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [owner]);
  await h.pg!.query(
    `INSERT INTO "Collection" (id, "userId", "nsfwLevel", type) VALUES ($1, $2, $3, $4)`,
    [id, owner, level, type]
  );
  await h.pg!.query(`INSERT INTO "CollectionItem" ("collectionId") VALUES ($1)`, [id]);
  h.cards.set(id, { userId: owner, type });
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
    types,
    userId,
  }: {
    browsingLevel?: number;
    user?: SessionUser;
    types?: ('Image' | 'Model')[];
    userId?: number;
  } = {}
) =>
  searchSemanticCollections({
    input: { query: 'cats', browsingLevel, types, userId, limit: 10 },
    ctx: { user, features: {}, req: {} } as never,
    candidateSource: ranking(ids),
  });
const shown = (r: { items: { id: number }[] }) => r.items.map((c) => c.id);

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

describe('semantic collection search', () => {
  it("asks for the viewer's levels and the feed filters, without hidden creators", async () => {
    await search([], { browsingLevel: PG | R, user: MOD, types: ['Model'], userId: 7 });
    expect(sent[0]).toMatchObject({
      gate: { kind: 'level', nsfwLevels: [PG, R] },
      anyOf: { type: ['Model'] },
      userIds: [7],
      excludedUserIds: [901],
    });
  });

  it('serves an eligible collection, in rank order', async () => {
    await collection(1);
    await collection(2);
    expect(shown(await search([2, 1]))).toEqual([2, 1]);
  });

  it('does not serve a collection that lost eligibility since it was indexed', async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) await collection(id);
    await h.pg!.exec(`
      UPDATE "User" SET "bannedAt" = now() WHERE id = 2;
      UPDATE "Collection" SET read = 'Private' WHERE id = 3;
      UPDATE "CollectionItem" SET status = 'REJECTED' WHERE "collectionId" = 4;
      INSERT INTO "CsamReport" ("userId") VALUES (5);
      UPDATE "Collection" SET "nsfwLevel" = 33 WHERE id = 6;`);
    // 5's owner is held. A held owner does not hide the row.
    expect(shown(await search([6, 5, 4, 3, 2, 1]))).toEqual([5, 1]);
    expect(h.fetched).toEqual([[5, 1]]);
  });

  it("re-checks the collection's level against the viewer's", async () => {
    await collection(1);
    await collection(2, { level: R });
    expect(shown(await search([2, 1], { browsingLevel: PG }))).toEqual([1]);
    expect(shown(await search([2, 1], { browsingLevel: PG | R, user: MOD }))).toEqual([2, 1]);
  });

  it('drops hidden creators, honours the filters, and caps one creator', async () => {
    await collection(1, { owner: 901 });
    await collection(2, { type: 'Model' });
    for (const id of [10, 11, 12, 13]) await collection(id, { owner: 7 });
    const result = await search([1, 2, 10, 11, 12, 13]);
    expect(shown(result)).toEqual([2, 10, 11, 12]);
    expect(result.items.filter((c) => c.userId === 7)).toHaveLength(MAX_HITS_PER_USER);
    expect(shown(await search([2, 10], { types: ['Image'] }))).toEqual([10]);
    expect(shown(await search([2, 10], { userId: 2 }))).toEqual([2]);
  });

  it('refuses a refused query before asking the index', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    await collection(1);
    expect(shown(await search([1], { user: MOD }))).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describeSemanticAuditContract({
  index: 'collections',
  run: async ({ source, user, cursor }) => {
    for (const id of [1, 2]) await collection(id);
    return searchSemanticCollections({
      input: { query: 'cats', browsingLevel: PG, limit: 10, cursor },
      ctx: { user, features: {}, req: {} } as never,
      candidateSource: source,
    });
  },
  ids: [1, 2],
  recorded: h.recordAudit,
  narrowToMinor: () => h.includesInappropriate.mockReturnValue('minor'),
  refuse: () => h.includesInappropriate.mockReturnValue('poi'),
});
