import { Prisma, PrismaClient } from '@civitai/db-schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The live-author short-circuit (CREATOR_FEED_SHORTCIRCUIT) must return exactly the rows the feed
 * query returned before it — against a REAL Postgres, because the claim is about what Prisma's
 * relation filters, cursor and ordering do, which no mock reaches.
 *
 * The oracle is `originalFeed` below: the feed query copied verbatim from before the short-circuit
 * existed, run directly on the fixture database. Both production paths (switch off, switch on with
 * a cold and a warm cache) are compared against it, so a change to the shared `where` cannot pass
 * by moving both sides at once.
 *
 * Runs in CI on the `unit` job's throwaway Postgres (the URL that job sets for the hot-reads-2
 * parity suite); the last test fails there if that wiring is lost. Locally it skips without a URL,
 * which must point at a THROWAWAY database: the suite drops and recreates its own schema.
 */
const databaseUrl =
  process.env.CREATOR_FEED_PARITY_DATABASE_URL ??
  process.env.KYSELY_HOT_READS_2_PARITY_DATABASE_URL;
const SCHEMA = 'creator_feed_parity';

const switchState = vi.hoisted(() => ({ on: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async (flag: string) =>
    flag === 'creator-feed-shortcircuit' ? switchState.on : false
  ),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser: vi.fn(async () => false),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
}));

import { getFollowedAnnouncements, resetLiveAuthorCache } from '../creator-announcement.service';

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

const PG_TYPES: Record<string, string> = {
  String: 'text',
  Int: 'integer',
  BigInt: 'bigint',
  Float: 'double precision',
  Decimal: 'numeric',
  Boolean: 'boolean',
  DateTime: 'timestamp(3)',
  Json: 'jsonb',
  Bytes: 'bytea',
};
const PG_DEFAULTS: Record<string, string> = {
  text: "''",
  integer: '0',
  bigint: '0',
  'double precision': '0',
  numeric: '0',
  boolean: 'false',
  'timestamp(3)': 'now()',
  jsonb: "'{}'",
  bytea: "''",
};

const MODELS = ['User', 'Announcement', 'UserEngagement', 'UserAnnouncementMute', 'Image'];

/** Enum types are created for real: Prisma casts an enum parameter to the column's type. */
function ddlFor(models: string[]) {
  const datamodel = Prisma.dmmf.datamodel;
  const enumNames = new Set<string>();
  const tables = models.map((modelName) => {
    const model = datamodel.models.find((m) => m.name === modelName);
    if (!model) throw new Error(`no ${modelName} model in the generated client`);
    const columns = model.fields
      .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
      .map((f) => {
        let base: string;
        let fallback: string;
        if (f.kind === 'enum') {
          enumNames.add(f.type);
          const first = datamodel.enums.find((e) => e.name === f.type)?.values[0];
          base = `"${SCHEMA}"."${f.type}"`;
          fallback = `'${first?.dbName ?? first?.name}'`;
        } else {
          base = PG_TYPES[f.type];
          if (!base) throw new Error(`no Postgres type for ${modelName}.${f.name} (${f.type})`);
          fallback = PG_DEFAULTS[base];
        }
        const def = f.isList ? `'{}'` : fallback;
        const required = f.isRequired || f.isList ? ` NOT NULL DEFAULT ${def}` : '';
        return `"${f.dbName ?? f.name}" ${base}${f.isList ? '[]' : ''}${required}`;
      });
    return `CREATE TABLE "${SCHEMA}"."${model.dbName ?? model.name}" (${columns.join(', ')})`;
  });
  const enums = [...enumNames].map((name) => {
    const values = datamodel.enums
      .find((e) => e.name === name)!
      .values.map((v) => `'${v.dbName ?? v.name}'`);
    return `CREATE TYPE "${SCHEMA}"."${name}" AS ENUM (${values.join(', ')})`;
  });
  return [...enums, ...tables];
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
// Every id is distinct from every other id, user or row, so a result that leaks the wrong one
// cannot coincide with a right one.
const NOW = new Date('2031-03-04T05:06:07.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const VIEWER = 1001; // follows most authors below
const LONER = 1002; // follows nobody
const NARROW = 1003; // follows only PLAIN

const PLAIN = 2001; // followed by VIEWER and NARROW; the row-level predicates live here
const MUTED = 2002; // followed by VIEWER, who muted their announcements
const HIDDEN = 2003; // VIEWER's engagement with them is Hide (one engagement row per pair)
const BLOCKS_VIEWER = 2004; // followed by VIEWER, and has blocked VIEWER
const UNFOLLOWED = 2005; // live, followed by no one
const FOLLOWS_VIEWER = 2006; // follows VIEWER — the wrong direction
const ONLY_DEAD = 2007; // followed by VIEWER, but every row is unfeedable
const PROLIFIC = 2008; // followed by VIEWER, several live rows for paging and ties
const VIEWER_BLOCKED = 2009; // VIEWER's engagement with them is Block
const SOON = 2010; // followed by NARROW; their ONLY row starts 20s from now

type Row = {
  id: number;
  userId: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  disabled?: boolean;
  profileOnly?: boolean;
  domain?: string[];
};

const ROWS: Row[] = [
  // PLAIN: one row per window/flag/domain case.
  { id: 101, userId: PLAIN, startsAt: null }, // no start: live, sorts last
  { id: 102, userId: PLAIN, startsAt: at(-DAY) },
  { id: 103, userId: PLAIN, startsAt: at(-2 * DAY), endsAt: at(-1) }, // ended a ms ago
  { id: 104, userId: PLAIN, startsAt: at(-2 * DAY), endsAt: NOW }, // ends exactly now: live
  { id: 105, userId: PLAIN, startsAt: NOW }, // starts exactly now: live
  { id: 106, userId: PLAIN, startsAt: at(DAY) }, // next week-ish: not yet
  { id: 107, userId: PLAIN, startsAt: at(45_000) }, // inside the cache lookahead: not yet
  { id: 108, userId: PLAIN, startsAt: at(-3 * DAY), profileOnly: true },
  { id: 109, userId: PLAIN, startsAt: at(-3 * DAY), disabled: true },
  { id: 110, userId: PLAIN, startsAt: at(-4 * DAY), domain: ['green'] },
  { id: 111, userId: PLAIN, startsAt: at(-4 * DAY), domain: ['red'] },
  { id: 112, userId: PLAIN, startsAt: at(-4 * DAY), domain: ['blue', 'red'] },
  { id: 201, userId: MUTED, startsAt: at(-DAY) },
  { id: 301, userId: HIDDEN, startsAt: at(-DAY) },
  { id: 401, userId: BLOCKS_VIEWER, startsAt: at(-DAY) },
  { id: 501, userId: UNFOLLOWED, startsAt: at(-DAY) },
  { id: 601, userId: FOLLOWS_VIEWER, startsAt: at(-DAY) },
  { id: 701, userId: ONLY_DEAD, startsAt: at(-DAY), profileOnly: true },
  { id: 702, userId: ONLY_DEAD, startsAt: at(-DAY), disabled: true },
  { id: 703, userId: ONLY_DEAD, startsAt: at(-3 * DAY), endsAt: at(-DAY) },
  // PROLIFIC: two pairs sharing a start, so the id tiebreak decides their order.
  { id: 801, userId: PROLIFIC, startsAt: at(-5 * MIN) },
  { id: 802, userId: PROLIFIC, startsAt: at(-5 * MIN) },
  { id: 803, userId: PROLIFIC, startsAt: at(-7 * MIN) },
  { id: 804, userId: PROLIFIC, startsAt: at(-7 * MIN) },
  { id: 805, userId: PROLIFIC, startsAt: null },
  { id: 901, userId: VIEWER_BLOCKED, startsAt: at(-DAY) },
  { id: 951, userId: null, startsAt: at(-DAY) }, // a platform row
  { id: 961, userId: SOON, startsAt: at(20_000) }, // starts inside the live-author cache's TTL
];

const ENGAGEMENTS: [number, number, string][] = [
  [VIEWER, PLAIN, 'Follow'],
  [VIEWER, MUTED, 'Follow'],
  [VIEWER, HIDDEN, 'Hide'],
  [VIEWER, BLOCKS_VIEWER, 'Follow'],
  [BLOCKS_VIEWER, VIEWER, 'Block'],
  [FOLLOWS_VIEWER, VIEWER, 'Follow'],
  [VIEWER, ONLY_DEAD, 'Follow'],
  [VIEWER, PROLIFIC, 'Follow'],
  [VIEWER, VIEWER_BLOCKED, 'Block'],
  [NARROW, PLAIN, 'Follow'],
  [NARROW, SOON, 'Follow'],
];
const MUTES: [number, number][] = [[VIEWER, MUTED]];

// ── The oracle: the feed query as it was before the short-circuit ─────────────────────────────
let client: PrismaClient;

async function originalFeed({
  userId,
  limit = 20,
  cursor,
  domain,
}: {
  userId: number;
  limit?: number;
  cursor?: number;
  domain?: string;
}) {
  const now = new Date();
  const rows = await client.announcement.findMany({
    where: {
      profileOnly: false,
      disabled: false,
      userId: { not: null },
      user: {
        announcementMutesReceived: { none: { userId } },
        engagingUsers: { none: { targetUserId: userId, type: 'Block' } },
        AND: [
          { engagedUsers: { some: { userId, type: 'Follow' } } },
          { engagedUsers: { none: { userId, type: { in: ['Block', 'Hide'] } } } },
        ],
      },
      ...(domain ? { domain: { hasSome: ['all', domain] } } : {}),
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
    } as Prisma.AnnouncementWhereInput,
    select: { id: true },
    orderBy: [{ startsAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const ids = rows.slice(0, limit).map((x) => x.id);
  return { ids, nextCursor: rows.length > limit ? ids[ids.length - 1] : undefined };
}

async function feed(input: { userId: number; limit?: number; cursor?: number; domain?: string }) {
  const page = await getFollowedAnnouncements(
    input as Parameters<typeof getFollowedAnnouncements>[0]
  );
  return { ids: page.items.map((x) => x.id), nextCursor: page.nextCursor, items: page.items };
}

const VIEWERS = [VIEWER, LONER, NARROW, PLAIN, MUTED, BLOCKS_VIEWER, SOON];
const DOMAINS = [undefined, 'green', 'blue', 'red'];

describe.skipIf(!databaseUrl)(
  'the followed feed with and without the live-author short-circuit',
  () => {
    let admin: PrismaClient;

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);

      admin = new PrismaClient({ datasourceUrl: withSchema(databaseUrl as string) });
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
      for (const statement of ddlFor(MODELS)) await admin.$executeRawUnsafe(statement);

      const userIds = [
        VIEWER,
        LONER,
        NARROW,
        PLAIN,
        MUTED,
        HIDDEN,
        BLOCKS_VIEWER,
        UNFOLLOWED,
        FOLLOWS_VIEWER,
        ONLY_DEAD,
        PROLIFIC,
        VIEWER_BLOCKED,
        SOON,
      ];
      for (const id of userIds)
        await admin.$executeRawUnsafe(
          `INSERT INTO "${SCHEMA}"."User" (id, username) VALUES (${id}, 'u${id}')`
        );
      for (const row of ROWS)
        await admin.announcement.create({
          data: {
            id: row.id,
            userId: row.userId,
            title: `t${row.id}`,
            content: `c${row.id}`,
            startsAt: row.startsAt ?? null,
            endsAt: row.endsAt ?? null,
            disabled: row.disabled ?? false,
            profileOnly: row.profileOnly ?? false,
            domain: (row.domain ?? ['all']) as never,
            createdAt: at(-10 * DAY),
            metadata: {},
          } as never,
        });
      for (const [userId, targetUserId, type] of ENGAGEMENTS)
        await admin.userEngagement.create({ data: { userId, targetUserId, type: type as never } });
      for (const [userId, creatorId] of MUTES)
        await admin.userAnnouncementMute.create({ data: { userId, creatorId } });

      client = admin;
      dbMock.dbRead.announcement.findMany.mockImplementation(((args: never) =>
        client.announcement.findMany(args)) as never);
      dbMock.dbRead.userEngagement.findMany.mockImplementation(((args: never) =>
        client.userEngagement.findMany(args)) as never);
    });

    beforeEach(() => {
      vi.setSystemTime(NOW);
      resetLiveAuthorCache();
      switchState.on = false;
    });

    afterAll(async () => {
      vi.useRealTimers();
      await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin?.$disconnect();
    });

    it('the fixtures exercise every predicate (oracle, pinned)', async () => {
      // Pinned literally, so this is the positive control for the comparisons below: each
      // excluded id is a predicate that removed something, and each included one a row that
      // survived all of them. 103 ended, 106/107 not started, 108 profileOnly, 109 disabled, 111
      // red-only; 201 muted, 301 hidden, 401 blocks the viewer, 501 unfollowed, 601 wrong
      // direction, 7xx unfeedable, 901 blocked by the viewer, 951 platform.
      expect((await originalFeed({ userId: VIEWER, limit: 50 })).ids).toEqual([
        105, 802, 801, 804, 803, 102, 104, 112, 111, 110, 805, 101,
      ]);
      expect((await originalFeed({ userId: VIEWER, limit: 50, domain: 'green' })).ids).toEqual([
        105, 802, 801, 804, 803, 102, 104, 110, 805, 101,
      ]);
      expect((await originalFeed({ userId: LONER, limit: 50 })).ids).toEqual([]);
    });

    for (const on of [false, true]) {
      it(`matches the original query for every viewer, domain and page size (switch ${
        on ? 'on' : 'off'
      })`, async () => {
        switchState.on = on;
        const followReadsBefore = dbMock.dbRead.userEngagement.findMany.mock.calls.length;
        let compared = 0;
        for (const userId of VIEWERS)
          for (const domain of DOMAINS)
            for (const limit of [1, 2, 3, 20]) {
              // Walk every page by cursor, then start once from a cursor on a row this viewer
              // cannot see.
              const starts: (number | undefined)[] = [undefined, 103];
              for (const start of starts) {
                let cursor = start;
                for (let page = 0; page < 20; page++) {
                  const expected = await originalFeed({ userId, limit, cursor, domain });
                  const actual = await feed({ userId, limit, cursor, domain });
                  expect({ ids: actual.ids, nextCursor: actual.nextCursor }).toEqual(expected);
                  compared += 1;
                  if (!expected.nextCursor) break;
                  cursor = expected.nextCursor;
                }
              }
            }
        // The walk itself is bounded and must have compared pages, not zero of them.
        expect(compared).toBeGreaterThan(VIEWERS.length * DOMAINS.length * 4 * 2);
        // Which path ran: with the switch on the narrowing follow read must have happened, or
        // an inert switch would make this an off-versus-oracle comparison that proves nothing.
        const followReads =
          dbMock.dbRead.userEngagement.findMany.mock.calls.length - followReadsBefore;
        if (on) expect(followReads).toBeGreaterThan(0);
        else expect(followReads).toBe(0);
      });
    }

    it('returns identical items, not just ids, on both paths', async () => {
      switchState.on = false;
      const off = await feed({ userId: VIEWER, limit: 50 });
      switchState.on = true;
      const on = await feed({ userId: VIEWER, limit: 50 });
      expect(on.items.length).toBe(12);
      expect(on.items).toEqual(off.items);
    });

    it('an author whose only row starts while the live-author set is cached appears on time', async () => {
      // The set is built at NOW, when SOON has nothing live; 25s later — inside the set's 30s
      // lifetime, so the cached set is what answers — 961 has started and the original query
      // shows it. A set built on the bare live window would hide it until the next refresh.
      switchState.on = true;
      const followReadsBefore = dbMock.dbRead.userEngagement.findMany.mock.calls.length;
      const before = await feed({ userId: NARROW, limit: 50 });
      expect(before.ids).not.toContain(961);
      // The narrowing path ran (see the walk above for why this is asserted).
      expect(dbMock.dbRead.userEngagement.findMany.mock.calls.length).toBeGreaterThan(
        followReadsBefore
      );

      vi.setSystemTime(at(25_000));
      const expected = await originalFeed({ userId: NARROW, limit: 50 });
      expect(expected.ids).toContain(961);
      expect((await feed({ userId: NARROW, limit: 50 })).ids).toEqual(expected.ids);
    });
  }
);

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(databaseUrl).toBeTruthy();
});
