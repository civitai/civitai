import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { BountyStatus, NsfwLevel } from '~/server/common/enums';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
import { describeSemanticAuditContract } from './semantic-audit.harness';

const h = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  pg: null as null | PGlite,
  // The feed card of each id, as getInfiniteBountiesHandler reads it: owner, tags, image levels.
  cards: new Map<number, { userId: number; tags: number[]; imageLevels: number[] }>(),
  feedInput: [] as Record<string, unknown>[],
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
vi.mock('~/server/controllers/bounty.controller', () => ({
  getInfiniteBountiesHandler: async ({
    input,
  }: {
    input: { ids: number[] } & Record<string, unknown>;
  }) => {
    h.fetched.push(input.ids);
    h.feedInput.push(input);
    return {
      items: input.ids.flatMap((id) => {
        const card = h.cards.get(id);
        return card
          ? [
              {
                id,
                user: { id: card.userId },
                tags: card.tags,
                images: card.imageLevels.map((nsfwLevel, i) => ({ id: id * 10 + i, nsfwLevel })),
              },
            ]
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

const { searchSemanticBounties, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-bounty-search.service'
);

const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "EvidenceHeldUser" ("userId" int);
  CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability text DEFAULT 'Public',
    poi boolean DEFAULT false, nsfw boolean DEFAULT false, "nsfwLevel" int);
`;

const { PG, R, XXX } = NsfwLevel;

/** An eligible bounty `id`, and its feed card. */
async function bounty(
  id: number,
  {
    owner = id,
    level = PG,
    tags = [],
    imageLevels = [level],
  }: { owner?: number; level?: number; tags?: number[]; imageLevels?: number[] } = {}
) {
  await h.pg!.query(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [owner]);
  await h.pg!.query(`INSERT INTO "Bounty" (id, "userId", "nsfwLevel") VALUES ($1, $2, $3)`, [
    id,
    owner,
    level,
  ]);
  h.cards.set(id, { userId: owner, tags, imageLevels });
}

let sent: CandidateFilter[];
const ranking =
  (ids: number[]): CandidateSource =>
  async ({ filter, offset, limit }) => {
    sent.push(filter);
    return { ids: ids.slice(offset, offset + limit) };
  };

const MOD = { id: 501, isModerator: true } as SessionUser;
type Filters = Partial<
  Pick<
    Parameters<typeof searchSemanticBounties>[0]['input'],
    'types' | 'mode' | 'status' | 'baseModels' | 'userId'
  >
>;
const search = (
  ids: number[],
  {
    browsingLevel = PG,
    user,
    ...filters
  }: { browsingLevel?: number; user?: SessionUser } & Filters = {}
) =>
  searchSemanticBounties({
    input: { query: 'lora', browsingLevel, limit: 10, ...filters },
    ctx: { user, features: {}, req: {} } as never,
    candidateSource: ranking(ids),
  });
const shown = (r: { items: { id: number }[] }) => r.items.map((b) => b.id);

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
  h.feedInput = [];
  h.includesInappropriate.mockReset().mockReturnValue(false);
  h.evalBoolean.mockReset().mockReturnValue({ enabled: true });
  h.fliptClient = { evaluateBoolean: () => h.evalBoolean() };
  loggingMock.logToAxiom.mockClear();
});

describe('semantic bounty search', () => {
  it("asks for the viewer's levels and the feed filters, without hidden creators", async () => {
    await search([], {
      browsingLevel: PG | R,
      user: MOD,
      types: ['LoraCreation'],
      mode: 'Split',
      baseModels: ['SDXL 1.0'],
      userId: 7,
    });
    expect(sent[0]).toMatchObject({
      gate: { kind: 'level', nsfwLevels: [PG, R] },
      anyOf: { type: ['LoraCreation'], mode: ['Split'], baseModel: ['SDXL 1.0'] },
      userIds: [7],
      excludedUserIds: [901],
    });
  });

  it('hydrates through the feed query, with the clock-bound status filter', async () => {
    await bounty(1);
    await bounty(2);
    expect(shown(await search([2, 1], { status: BountyStatus.Open }))).toEqual([2, 1]);
    expect(h.feedInput[0]).toMatchObject({ ids: [2, 1], status: BountyStatus.Open });
  });

  it('does not serve a bounty that lost eligibility since it was indexed', async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) await bounty(id);
    await h.pg!.exec(`
      UPDATE "User" SET "bannedAt" = now() WHERE id = 2;
      UPDATE "Bounty" SET availability = 'Private' WHERE id = 3;
      UPDATE "Bounty" SET poi = true WHERE id = 4;
      INSERT INTO "CsamReport" ("userId") VALUES (5);
      UPDATE "Bounty" SET "nsfwLevel" = 33 WHERE id = 6;`);
    expect(shown(await search([6, 5, 4, 3, 2, 1]))).toEqual([1]);
    // Dropped before the feed read, so nothing of theirs is fetched.
    expect(h.fetched).toEqual([[1]]);
  });

  it('re-checks the level the feed serves at, XXX for a bounty marked nsfw', async () => {
    await bounty(1);
    await bounty(2, { level: R });
    await bounty(3);
    await h.pg!.exec(`UPDATE "Bounty" SET nsfw = true WHERE id = 3`);
    expect(shown(await search([3, 2, 1], { browsingLevel: PG | R, user: MOD }))).toEqual([2, 1]);
    expect(shown(await search([3, 2, 1], { browsingLevel: PG | R | XXX, user: MOD }))).toEqual([
      3, 2, 1,
    ]);
  });

  it('drops images above the searched level, and a bounty left with none', async () => {
    // Rated PG, its images not: a moderator override, or a re-rating the level job has not caught.
    await bounty(1, { imageLevels: [PG, R] });
    await bounty(2, { imageLevels: [R] });
    const result = await search([2, 1], { browsingLevel: PG, user: MOD });
    expect(shown(result)).toEqual([1]);
    expect(result.items[0].images.map((i) => i.nsfwLevel)).toEqual([PG]);
  });

  it('drops hidden creators and tags, honours the creator filter, and caps one creator', async () => {
    await bounty(1, { owner: 901 });
    await bounty(2, { tags: [66] });
    await bounty(3);
    for (const id of [10, 11, 12, 13]) await bounty(id, { owner: 7 });
    const result = await search([1, 2, 3, 10, 11, 12, 13]);
    expect(shown(result)).toEqual([3, 10, 11, 12]);
    expect(result.items.filter((b) => b.user.id === 7)).toHaveLength(MAX_HITS_PER_USER);
    expect(shown(await search([3, 10], { userId: 7 }))).toEqual([10]);
  });

  it('refuses a refused query before asking the index', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    await bounty(1);
    expect(shown(await search([1], { user: MOD }))).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describeSemanticAuditContract({
  index: 'bounties',
  run: async ({ source, user, cursor }) => {
    for (const id of [1, 2]) await bounty(id);
    return searchSemanticBounties({
      input: { query: 'lora', browsingLevel: PG, limit: 10, cursor },
      ctx: { user, features: {}, req: {} } as never,
      candidateSource: source,
    });
  },
  ids: [1, 2],
  recorded: h.recordAudit,
  narrowToMinor: () => h.includesInappropriate.mockReturnValue('minor'),
  refuse: () => h.includesInappropriate.mockReturnValue('poi'),
});
