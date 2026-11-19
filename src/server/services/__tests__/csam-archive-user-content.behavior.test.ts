import { PGlite } from '@electric-sql/pglite';
import type { DB } from '@civitai/db-schema/kysely';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userContentReaders } from '~/server/services/csam-archive-user-content';

/**
 * The text sections of a report archive, read against a Postgres stand-in: each holds the reported
 * user's rows only, in id order across page boundaries, with only its listed columns. Ids and text
 * are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ME = 20;
const OTHER = 30;
const PAGE = 2;

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

/**
 * Each table carries every column the section lists plus one it must not (`secret`). The owner
 * column is `userId` except where noted.
 */
const OWNED: { section: string; table: string; owner: string; columns: string[] }[] = [
  {
    section: 'posts',
    table: 'Post',
    owner: 'userId',
    columns: ['id', 'userId', 'title', 'detail', 'createdAt', 'updatedAt', 'publishedAt'],
  },
  {
    section: 'postTexts',
    table: 'PostText',
    owner: 'userId',
    columns: ['id', 'postId', 'userId', 'index', 'content', 'csamHeld', 'createdAt', 'updatedAt'],
  },
  {
    section: 'articles',
    table: 'Article',
    owner: 'userId',
    columns: ['id', 'userId', 'title', 'content', 'createdAt', 'updatedAt', 'publishedAt'],
  },
  {
    section: 'resourceReviews',
    table: 'ResourceReview',
    owner: 'userId',
    columns: ['id', 'userId', 'modelId', 'modelVersionId', 'details', 'createdAt'],
  },
  {
    section: 'collections',
    table: 'Collection',
    owner: 'userId',
    columns: ['id', 'userId', 'name', 'description', 'createdAt'],
  },
  {
    section: 'bounties',
    table: 'Bounty',
    owner: 'userId',
    columns: ['id', 'userId', 'name', 'description', 'details', 'createdAt'],
  },
  {
    section: 'bountyEntries',
    table: 'BountyEntry',
    owner: 'userId',
    columns: ['id', 'userId', 'bountyId', 'description', 'createdAt'],
  },
  {
    section: 'serviceOfferings',
    table: 'ServiceOffering',
    owner: 'sellerId',
    columns: [
      'id',
      'sellerId',
      'title',
      'description',
      'removedReason',
      'removedDetails',
      'removedAt',
      'createdAt',
    ],
  },
  {
    section: 'questions',
    table: 'Question',
    owner: 'userId',
    columns: ['id', 'userId', 'title', 'content', 'createdAt'],
  },
  {
    section: 'answers',
    table: 'Answer',
    owner: 'userId',
    columns: ['id', 'questionId', 'userId', 'content', 'createdAt'],
  },
];

const TIME_COLUMNS = new Set(['createdAt', 'updatedAt', 'publishedAt', 'removedAt']);
const typeOf = (column: string) =>
  column === 'id'
    ? 'INTEGER PRIMARY KEY'
    : TIME_COLUMNS.has(column)
    ? 'TIMESTAMP(3)'
    : column === 'csamHeld'
    ? 'BOOLEAN'
    : /Id$|^index$/.test(column)
    ? 'INTEGER'
    : 'TEXT';

const ddl = (table: string, columns: string[]) =>
  `CREATE TABLE "${table}" (${[...columns, 'secret']
    .map((c) => `"${c}" ${c === 'secret' ? 'TEXT' : typeOf(c)}`)
    .join(', ')});`;

const pg = new PGlite({
  parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
});
const db = new Kysely<DB>({ dialect: dialect(pg) });

const read = async (section: string, userId: number, pageSize = PAGE) => {
  const reader = userContentReaders.find((r) => r.name === section);
  if (!reader) throw new Error(`no section ${section}`);
  const rows: Record<string, unknown>[] = [];
  for await (const row of reader.rows(db, userId, pageSize)) {
    // A cursor that never advances fails here rather than hanging the run.
    if (rows.length > 100) throw new Error(`${section} scan did not end`);
    rows.push(row as Record<string, unknown>);
  }
  return rows;
};

beforeAll(async () => {
  for (const { table, columns } of OWNED) await pg.exec(ddl(table, columns));
  await pg.exec(`
    ${ddl('UserProfile', [
      'userId',
      'bio',
      'message',
      'messageAddedAt',
      'sfwBio',
      'sfwMessage',
      'location',
    ])
      .replace('"userId" INTEGER', '"userId" INTEGER PRIMARY KEY')
      .replace('"messageAddedAt" TEXT', '"messageAddedAt" TIMESTAMP(3)')}
    CREATE TABLE "ChatMember" (id SERIAL PRIMARY KEY, "chatId" INTEGER NOT NULL, "userId" INTEGER NOT NULL);
    ${ddl('ChatMessage', [
      'id',
      'chatId',
      'userId',
      'content',
      'createdAt',
      'editedAt',
      'deletedAt',
      'referenceMessageId',
    ])
      .replace('"editedAt" TEXT', '"editedAt" TIMESTAMP(3)')
      .replace('"deletedAt" TEXT', '"deletedAt" TIMESTAMP(3)')}
  `);
});
afterAll(() => pg.close());

beforeEach(async () => {
  const tables = [...OWNED.map((o) => o.table), 'UserProfile', 'ChatMember', 'ChatMessage'];
  await pg.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')};`);
});

describe('the archive text sections', () => {
  it('lists every section the archive writes, in order', () => {
    expect(userContentReaders.map((r) => r.name)).toEqual([
      'posts',
      'postTexts',
      'articles',
      'chatMessages',
      'profile',
      'resourceReviews',
      'collections',
      'bounties',
      'bountyEntries',
      'serviceOfferings',
      'questions',
      'answers',
    ]);
  });

  describe.each(OWNED)('$section', ({ section, table, owner, columns }) => {
    it("holds only the user's rows, in id order across pages, with only the listed columns", async () => {
      // Five of mine across three pages of two, interleaved with someone else's, inserted out of order.
      const ids = [9, 2, 7, 4, 11];
      const others = [3, 8, 10];
      const insert = async (id: number, userId: number) => {
        const values = columns.map((c) =>
          c === 'id'
            ? id
            : c === owner
            ? userId
            : TIME_COLUMNS.has(c)
            ? new Date(Date.UTC(2026, 9, 1))
            : c === 'csamHeld'
            ? false
            : /Id$|^index$/.test(c)
            ? 1
            : `${c}-${id}`
        );
        await pg.query(
          `INSERT INTO "${table}" (${[...columns, 'secret'].map((c) => `"${c}"`).join(', ')})
           VALUES (${[...columns, 'secret'].map((_, i) => `$${i + 1}`).join(', ')})`,
          [...values, 'not for the archive']
        );
      };
      for (const id of ids) await insert(id, ME);
      for (const id of others) await insert(id, OTHER);

      const rows = await read(section, ME);

      expect(rows.map((r) => r.id)).toEqual([2, 4, 7, 9, 11]);
      expect(rows.every((r) => r[owner] === ME)).toBe(true);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual([...columns].sort());
    });

    it('yields nothing for a user with no rows', async () => {
      expect(await read(section, ME)).toEqual([]);
    });
  });

  describe('profile', () => {
    it("holds the user's profile row and nobody else's, with only the listed columns", async () => {
      await pg.query(
        `INSERT INTO "UserProfile" ("userId", bio, message, location, secret) VALUES
           ($1, 'my bio', 'my message', 'here', 'x'), ($2, 'their bio', NULL, NULL, 'x')`,
        [ME, OTHER]
      );
      const rows = await read('profile', ME);
      expect(rows).toEqual([
        {
          userId: ME,
          bio: 'my bio',
          message: 'my message',
          messageAddedAt: null,
          sfwBio: null,
          sfwMessage: null,
          location: 'here',
        },
      ]);
      expect(await read('profile', OTHER + 1)).toEqual([]);
    });
  });

  describe('chatMessages', () => {
    const message = (id: number, chatId: number, userId: number) =>
      pg.query(
        `INSERT INTO "ChatMessage" (id, "chatId", "userId", content, secret) VALUES ($1, $2, $3, $4, 'x')`,
        [id, chatId, userId, `m${id}`]
      );

    it("holds both sides of the user's chats and nothing from a chat they are not in", async () => {
      await pg.exec(`INSERT INTO "ChatMember" ("chatId", "userId") VALUES
        (5, ${ME}), (5, ${OTHER}), (6, ${ME}), (6, ${OTHER}), (7, ${OTHER}), (7, 40)`);
      // Chat 5 spans pages; chat 7 is someone else's conversation and must not appear.
      for (const [id, chat, from] of [
        [1, 5, ME],
        [2, 7, OTHER],
        [3, 5, OTHER],
        [4, 6, OTHER],
        [5, 5, ME],
        [6, 7, 40],
        [8, 5, OTHER],
      ])
        await message(id, chat, from);

      const rows = await read('chatMessages', ME);

      expect(rows.map((r) => [r.chatId, r.id, r.isReportedUser])).toEqual([
        [5, 1, true],
        [5, 3, false],
        [5, 5, true],
        [5, 8, false],
        [6, 4, false],
      ]);
      for (const row of rows)
        expect(Object.keys(row).sort()).toEqual(
          [
            'id',
            'chatId',
            'userId',
            'content',
            'createdAt',
            'editedAt',
            'deletedAt',
            'referenceMessageId',
            'isReportedUser',
          ].sort()
        );
    });

    it('yields nothing for a user in no chats', async () => {
      await pg.exec(`INSERT INTO "ChatMember" ("chatId", "userId") VALUES (7, ${OTHER})`);
      await message(1, 7, OTHER);
      expect(await read('chatMessages', ME)).toEqual([]);
    });
  });
});
