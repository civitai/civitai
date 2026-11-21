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
import { authorPassPool, userContentReaders } from '~/server/services/csam-archive-user-content';

/**
 * The text sections of a report archive, read against a Postgres stand-in: each holds the reported
 * user's rows only, in id order across page boundaries, with only its listed columns. Ids and text
 * are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ME = 20;
const OTHER = 30;
const PAGE = 2;

/** Every statement the readers send, so a test can see a section was paged rather than read whole. */
const queries: string[] = [];

const dialect = (pg: PGlite, sink: string[] = queries): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      sink.push(compiled.sql);
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
    section: 'serviceDealReviews',
    table: 'ServiceDealReview',
    owner: 'buyerId',
    columns: ['id', 'dealId', 'buyerId', 'comment', 'hiddenAt', 'createdAt', 'updatedAt'],
  },
  {
    section: 'serviceDealReviewReplies',
    table: 'ServiceDealReview',
    owner: 'sellerId',
    columns: ['id', 'dealId', 'sellerId', 'sellerReply', 'sellerReplyAt', 'hiddenAt'],
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
  // A table two sections read (a review's comment and its reply) is created once, with both lists.
  const tables = new Map<string, Set<string>>();
  for (const { table, columns } of OWNED)
    tables.set(table, new Set([...(tables.get(table) ?? []), ...columns]));
  for (const [table, columns] of tables) await pg.exec(ddl(table, [...columns]));
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
    CREATE TABLE "TextScanHold" (
      id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT 'csam',
      status TEXT NOT NULL, "decidedAt" TIMESTAMP(3), meta JSONB
    );
    CREATE TABLE "ChatMessageEdit" (
      id SERIAL PRIMARY KEY, "messageId" INTEGER NOT NULL, "editorId" INTEGER NOT NULL,
      "previousContent" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL, secret TEXT
    );
    CREATE TABLE "ChatMember" (
      id SERIAL PRIMARY KEY, "chatId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Joined', "leftAt" TIMESTAMP(3)
    );
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
  const tables = [
    ...new Set(OWNED.map((o) => o.table)),
    'UserProfile',
    'TextScanHold',
    'ChatMessageEdit',
    'ChatMember',
    'ChatMessage',
  ];
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
      'serviceDealReviews',
      'serviceDealReviewReplies',
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
            : c === 'csamHeld'
            ? id === 9
            : id === 7
            ? null
            : TIME_COLUMNS.has(c)
            ? new Date(Date.UTC(2026, 9, 1))
            : /Id$|^index$/.test(c)
            ? 1
            : id === 9
            ? ''
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

      const sent = queries.length;
      const rows = await read(section, ME);

      expect(rows.map((r) => r.id)).toEqual([2, 4, 7, 9, 11]);
      // Five rows at two per page: three statements, each limited to a page.
      const pages = queries.slice(sent).filter((q) => q.includes(`from "${table}"`));
      expect(pages).toHaveLength(3);
      for (const q of pages) expect(q).toMatch(/limit \$\d+$/);
      expect(rows.every((r) => r[owner] === ME)).toBe(true);
      // Unpublished, removed, blank or held rows come back as stored, not filtered or filled in.
      expect(rows.find((r) => r.id === 7)).toEqual(
        Object.fromEntries(
          columns.map((c) => [
            c,
            c === 'id' ? 7 : c === owner ? ME : c === 'csamHeld' ? false : null,
          ])
        )
      );
      const blank = rows.find((r) => r.id === 9)!;
      for (const c of columns.filter((c) => typeof blank[c] === 'string'))
        expect(blank[c]).toBe('');
      if (columns.includes('csamHeld')) expect(blank.csamHeld).toBe(true);
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
          blankedReasons: [],
        },
      ]);
      expect(await read('profile', OTHER + 1)).toEqual([]);
    });
  });

  describe('profile blanking', () => {
    it("names each confirmed decision on the user's profile and nothing else", async () => {
      await pg.query(`INSERT INTO "UserProfile" ("userId", bio) VALUES ($1, NULL)`, [ME]);
      await pg.query(
        `INSERT INTO "TextScanHold" (id, "entityType", "entityId", status, "decidedAt", meta) VALUES
           (46, 'UserProfile', $1, 'Confirmed', NULL, '{}'),
           (41, 'UserProfile', $1, 'Confirmed', '2026-10-05 12:00', '{"decision":"remove_ban"}'),
           (42, 'UserProfile', $1, 'Dismissed', '2026-10-06 12:00', '{"decision":"dismiss"}'),
           (43, 'UserProfile', $2, 'Confirmed', '2026-10-07 12:00', '{"decision":"remove"}'),
           (44, 'Post', $1, 'Confirmed', '2026-10-08 12:00', '{"decision":"remove"}'),
           (45, 'UserProfile', $1, 'Pending', NULL, NULL)`,
        [ME, OTHER]
      );
      // A confirmed hold of another kind does not clear the profile.
      await pg.query(
        `INSERT INTO "TextScanHold" (id, "entityType", "entityId", label, status, "decidedAt", meta)
         VALUES (47, 'UserProfile', $1, 'other', 'Confirmed', '2026-10-09 12:00', '{"decision":"remove"}')`,
        [ME]
      );
      const [row] = await read('profile', ME);
      expect(row.bio).toBeNull();
      expect(row.blankedReasons).toEqual([
        'blanked by decision remove_ban on hold 41 at 2026-10-05T12:00:00.000Z',
        'blanked by decision unknown on hold 46 at an unknown time',
      ]);
    });
  });

  describe('chatMessages', () => {
    const message = (
      id: number,
      chatId: number,
      userId: number,
      extra: {
        content?: string;
        createdAt?: Date;
        editedAt?: Date;
        deletedAt?: Date;
        referenceMessageId?: number;
      } = {}
    ) =>
      pg.query(
        `INSERT INTO "ChatMessage" (id, "chatId", "userId", content, "createdAt", "editedAt", "deletedAt", "referenceMessageId", secret)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'x')`,
        [
          id,
          chatId,
          userId,
          extra.content ?? `m${id}`,
          extra.createdAt ?? null,
          extra.editedAt ?? null,
          extra.deletedAt ?? null,
          extra.referenceMessageId ?? null,
        ]
      );

    it("holds both sides of the user's chats and nothing from a chat they are not in", async () => {
      // Memberships inserted out of chat order, with a duplicate row for chat 6. The user left
      // chat 3 before its last message, which is still archived.
      await pg.exec(`INSERT INTO "ChatMember" ("chatId", "userId", status, "leftAt") VALUES
        (6, ${ME}, 'Joined', NULL), (6, ${ME}, 'Joined', NULL), (5, ${ME}, 'Joined', NULL),
        (3, ${ME}, 'Left', '2026-10-02'), (2, ${ME}, 'Kicked', NULL), (1, ${ME}, 'Invited', NULL),
        (4, ${ME}, 'Ignored', NULL), (5, ${OTHER}, 'Joined', NULL), (6, ${OTHER}, 'Joined', NULL),
        (3, ${OTHER}, 'Joined', NULL), (7, ${OTHER}, 'Joined', NULL), (7, 40, 'Joined', NULL),
        (8, ${OTHER}, 'Joined', NULL)`);
      // Chat 5 spans pages; chat 7 is someone else's conversation and must not appear. Chat 8 has no
      // membership row of the user's: their own message there is archived, the other side's is not.
      await message(11, 3, OTHER, { createdAt: new Date(Date.UTC(2026, 9, 5)) });
      await message(12, 2, OTHER);
      await message(13, 1, OTHER);
      await message(14, 4, OTHER);
      // Inserted out of id order within chat 5.
      for (const [id, chat, from] of [
        [8, 5, OTHER],
        [2, 7, OTHER],
        [3, 5, OTHER],
        [4, 6, OTHER],
        [1, 5, ME],
        [6, 7, 40],
        [5, 5, ME],
        [9, 8, ME],
        [15, 8, OTHER],
        [16, 9, ME],
      ])
        await message(id, chat, from);
      // In a chat the user is not a member of: deleted and edited, and still archived as stored.
      await message(17, 8, ME, { content: 'kept', deletedAt: new Date(Date.UTC(2026, 9, 4)) });
      const editedAt = new Date(Date.UTC(2026, 9, 2));
      const deletedAt = new Date(Date.UTC(2026, 9, 3));
      await message(10, 5, ME, { content: '', editedAt, deletedAt, referenceMessageId: 1 });
      // Two edits of message 10 (inserted newest first) and one of message 4 in another chat; an
      // edit of message 2, in a chat the user is not in, must not appear.
      await pg.exec(`INSERT INTO "ChatMessageEdit" (id, "messageId", "editorId", "previousContent", "createdAt", secret) VALUES
        (32, 10, ${ME}, 'second draft', '2026-10-02 10:00', 'x'),
        (31, 10, ${ME}, 'first draft', '2026-10-02 09:00', 'x'),
        (33, 4, ${OTHER}, 'their draft', '2026-10-02 11:00', 'x'),
        (34, 2, ${OTHER}, 'not in scope', '2026-10-02 12:00', 'x'),
        (35, 17, ${ME}, 'before the edit', '2026-10-03 09:00', 'x')`);

      const sent = queries.length;
      const rows = await read('chatMessages', ME);
      // Edits are read per page of messages, not for the whole table.
      const editReads = queries.slice(sent).filter((q) => q.includes('from "ChatMessageEdit"'));
      expect(editReads.length).toBeGreaterThan(0);
      for (const q of editReads) expect(q).toMatch(/"messageId" in \(/);

      expect(rows.map((r) => [r.chatId, r.id, r.isReportedUser])).toEqual([
        [1, 13, false],
        [2, 12, false],
        [3, 11, false],
        [4, 14, false],
        [5, 1, true],
        [5, 3, false],
        [5, 5, true],
        [5, 8, false],
        [5, 10, true],
        [6, 4, false],
        [8, 9, true],
        [9, 16, true],
        [8, 17, true],
      ]);
      expect(rows.find((r) => r.id === 10)).toMatchObject({
        content: '',
        editedAt,
        deletedAt,
        referenceMessageId: 1,
        previousVersions: [
          {
            id: 31,
            editorId: ME,
            previousContent: 'first draft',
            createdAt: new Date(Date.UTC(2026, 9, 2, 9)),
          },
          {
            id: 32,
            editorId: ME,
            previousContent: 'second draft',
            createdAt: new Date(Date.UTC(2026, 9, 2, 10)),
          },
        ],
      });
      expect(rows.find((r) => r.id === 4)?.previousVersions).toEqual([
        expect.objectContaining({ id: 33, previousContent: 'their draft' }),
      ]);
      expect(rows.find((r) => r.id === 1)?.previousVersions).toEqual([]);
      expect(rows.find((r) => r.id === 17)).toMatchObject({
        content: 'kept',
        deletedAt: new Date(Date.UTC(2026, 9, 4)),
        previousVersions: [expect.objectContaining({ id: 35, previousContent: 'before the edit' })],
      });
      for (const row of rows)
        for (const version of row.previousVersions as Record<string, unknown>[])
          expect(Object.keys(version).sort()).toEqual([
            'createdAt',
            'editorId',
            'id',
            'previousContent',
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
            'previousVersions',
          ].sort()
        );
    });

    it('yields nothing for a user in no chats who wrote nothing', async () => {
      await pg.exec(`INSERT INTO "ChatMember" ("chatId", "userId") VALUES (7, ${OTHER})`);
      await message(1, 7, OTHER);
      expect(await read('chatMessages', ME)).toEqual([]);
    });

    it('holds only their own messages for a user with no membership rows at all', async () => {
      await pg.exec(`INSERT INTO "ChatMember" ("chatId", "userId") VALUES (7, ${OTHER})`);
      await message(1, 7, OTHER);
      await message(2, 7, ME);
      const rows = await read('chatMessages', ME);
      expect(rows.map((r) => [r.chatId, r.id, r.isReportedUser])).toEqual([[7, 2, true]]);
    });
  });
});

describe('the pool for the author pass', () => {
  const primary = 'postgres://primary.invalid/db';
  const replica = 'postgres://replica.invalid/db';
  const replicaLong = 'postgres://replica-long.invalid/db';

  it('is the long-read pool only when that pool is a replica', () => {
    expect(
      authorPassPool({ databaseUrl: primary, replicaUrl: replica, replicaLongUrl: replicaLong })
    ).toBe('readLong');
    // Long URL equal to the primary's, or unset: the long-read pool would be the primary.
    expect(
      authorPassPool({ databaseUrl: primary, replicaUrl: replica, replicaLongUrl: primary })
    ).toBe('read');
    expect(authorPassPool({ databaseUrl: primary, replicaUrl: replica })).toBe('read');
    // A read replica URL equal to the primary's makes every pool the primary's.
    expect(
      authorPassPool({ databaseUrl: primary, replicaUrl: primary, replicaLongUrl: replicaLong })
    ).toBe('read');
  });
});

describe('the author pass', () => {
  it('runs on the pool it is given', async () => {
    const authorQueries: string[] = [];
    const authorDb = new Kysely<DB>({ dialect: dialect(pg, authorQueries) });
    await pg.exec(`INSERT INTO "ChatMember" ("chatId", "userId") VALUES (5, ${ME})`);
    await pg.query(
      `INSERT INTO "ChatMessage" (id, "chatId", "userId", content, secret) VALUES
         (1, 5, $1, 'member chat', 'x'), (2, 8, $1, 'elsewhere', 'x')`,
      [ME]
    );
    const reader = userContentReaders.find((r) => r.name === 'chatMessages')!;
    const sent = queries.length;
    const rows: Record<string, unknown>[] = [];
    for await (const row of reader.rows(db, ME, PAGE, new Map(), authorDb))
      rows.push(row as Record<string, unknown>);

    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    const byAuthor = (q: string) => q.includes('from "ChatMessage"') && q.includes('"userId" =');
    expect(authorQueries.filter(byAuthor)).not.toHaveLength(0);
    expect(queries.slice(sent).filter(byAuthor)).toHaveLength(0);
  });
});
