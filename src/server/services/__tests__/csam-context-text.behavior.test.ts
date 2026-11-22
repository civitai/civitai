import { PGlite } from '@electric-sql/pglite';
import type { CsamContextSources } from '~/server/schema/csam.schema';
import type {
  CsamContextReview,
  CsamContextText,
  CsamItemContextText,
  CsamPostContextText,
} from '~/server/services/csam-context-text';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The text a moderator may attach to an image report, read from both comment tables against a
 * Postgres stand-in, and what NCMEC is sent for it. Ids and text are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type AuditEdit = { chatId: number; messageId: number; actorId: number };
const holder = vi.hoisted(() => {
  process.env.SERVER_DOMAIN_RED = 'red.example.invalid';
  return {
    kysely: null as unknown,
    clickhouse: undefined as { $query: (sql: string) => Promise<unknown[]> } | undefined,
  };
});
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get clickhouse() {
    return holder.clickhouse;
  },
}));
/** The audit log's edit rows, answering the one query shape the capture sends. */
const auditLog = (edits: AuditEdit[]) => {
  const $query = vi.fn(async (sql: string) => {
    const list = (col: string) =>
      (sql.match(new RegExp(`${col} IN \\(([\\d,]+)\\)`))?.[1] ?? '').split(',').map(Number);
    const notActor = Number(sql.match(/actorId != (\d+)/)?.[1]);
    expect(sql).toMatch(/type = 'edit'/);
    return edits
      .filter(
        (e) =>
          list('chatId').includes(e.chatId) &&
          list('messageId').includes(e.messageId) &&
          e.actorId !== notActor
      )
      .map((e) => ({ messageId: String(e.messageId) }));
  });
  holder.clickhouse = { $query };
  return $query;
};
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
  get kyselyV3Read() {
    return holder.kysely;
  },
  get kyselyWrite() {
    return holder.kysely;
  },
}));

const {
  getCsamContextCandidates,
  readHeldCsamContextText,
  snapshotCsamContextText,
  reportedUserIdsOf,
  foldContextText,
  contextIncidents,
  htmlToPlainText,
  getCsamItemCandidates,
  CSAM_CONTEXT_TEXT_MAX_CHARS,
} = await import('~/server/services/csam-context-text');
const { CSAM_CONTEXT_ITEM_SELECT_LIMIT } = await import(
  '~/shared/constants/csam-context.constants'
);
const RED = 'https://red.example.invalid';
const webPages = (c: CsamContextText[] | undefined) => contextIncidents(c).webPageIncidents;

const MOD = 10;
const OWNER = 20;
const OTHER = 30;
const SECONDARY = 40;

const db = { pg: null as unknown as PGlite };

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

const SCHEMA = `
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL, "publishedAt" TIMESTAMP(3)
);
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "postId" INTEGER, "userId" INTEGER NOT NULL);
CREATE TABLE "PostText" (
  "id" INTEGER PRIMARY KEY, "postId" INTEGER NOT NULL, "index" INTEGER NOT NULL, "content" TEXT NOT NULL,
  "userId" INTEGER NOT NULL DEFAULT 20, "csamHeld" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-10-02', "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-10-02'
);
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "label" TEXT NOT NULL, "status" TEXT NOT NULL, "decidedById" INTEGER, "decidedAt" TIMESTAMP(3),
  "meta" JSONB, "createdAt" TIMESTAMP(3) NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "UserProfile" (
  "userId" INTEGER PRIMARY KEY, "bio" TEXT, "message" TEXT, "messageAddedAt" TIMESTAMP(3),
  "sfwBio" TEXT, "sfwMessage" TEXT, "sfwMessageAddedAt" TIMESTAMP(3)
);
CREATE TABLE "ChatMessage" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "content" TEXT NOT NULL,
  "contentType" TEXT NOT NULL DEFAULT 'Markdown', "createdAt" TIMESTAMP(3) NOT NULL,
  "editedAt" TIMESTAMP(3), "deletedAt" TIMESTAMP(3), "chatId" INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
  "status" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3),
  "sfwName" TEXT, "sfwDescription" TEXT
);
CREATE TABLE "ChatMessageEdit" (
  "id" SERIAL PRIMARY KEY, "messageId" INTEGER NOT NULL, "editorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ModelOwnership" (
  "id" SERIAL PRIMARY KEY, "modelId" INTEGER NOT NULL, "userId" INTEGER NOT NULL, "reason" TEXT NOT NULL
);
CREATE TABLE "Article" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "title" TEXT NOT NULL, "content" TEXT NOT NULL,
  "status" TEXT NOT NULL, "createdAt" TIMESTAMP(3)
);
CREATE TABLE "ServiceOffering" (
  "id" INTEGER PRIMARY KEY, "sellerId" INTEGER NOT NULL, "title" TEXT NOT NULL,
  "description" TEXT NOT NULL, "status" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "CommentV3" (
  "id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL, "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3), "hidden" BOOLEAN NOT NULL DEFAULT false
);
`;

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 14, 5));

beforeAll(async () => {
  db.pg = new PGlite({
    parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
  });
  holder.kysely = new Kysely({ dialect: dialect(db.pg) });
  await db.pg.exec(SCHEMA);
});

beforeEach(async () => {
  await db.pg.exec(
    `TRUNCATE "Post", "Image", "CommentV3", "PostText", "TextScanHold", "ModActivity";
     INSERT INTO "Post" VALUES (100, ${OWNER}, '<p>caption &amp; <b>more</b></p>', '2026-10-01', '2026-10-02 08:30');
     INSERT INTO "Post" VALUES (200, ${OTHER}, '<p>unrelated post</p>', '2026-10-01', NULL);
     INSERT INTO "Post" VALUES (501, ${OTHER}, 'a post sharing an image id', '2026-10-01', NULL);
     INSERT INTO "Image" VALUES (501, 100, ${OWNER}), (502, NULL, ${OWNER}), (601, 200, ${OTHER});
     INSERT INTO "CommentV3" VALUES
       (11, 'post', 100, ${OTHER}, '<p>v3 on the post</p>', '2026-10-03', NULL, false),
       (12, 'image', 501, ${OWNER}, 'v3 on the image', '2026-10-04', '2026-10-05', false),
       (13, 'post', 200, ${OWNER}, 'v3 on an unrelated post', '2026-10-04', NULL, false),
       (14, 'post', 501, ${OTHER}, 'v3 on post 501, not image 501', '2026-10-04', NULL, false),
       (22, 'post', 100, ${OWNER}, 'a reply on the post', '2026-10-06', NULL, false),
       (23, 'image', 502, ${OTHER}, 'on the loose image', '2026-10-07', NULL, true);`
  );
});

const ids = (rows: { source: string; id: number }[]) =>
  rows.map((r) => `${r.source}:${r.id}`).sort();

describe('candidates', () => {
  it("lists the images' post descriptions and comments", async () => {
    const { candidates: rows, more } = await getCsamContextCandidates({
      userId: OWNER,
      imageIds: [501, 502],
    });
    expect(more).toBe(false);

    expect(ids(rows)).toEqual(
      ['postDescription:100', 'comment:11', 'comment:12', 'comment:22', 'comment:23'].sort()
    );
    expect(rows.find((r) => r.source === 'postDescription')?.text).toBe('caption & more');
    expect(rows.find((r) => r.id === 22)).toMatchObject({ postId: 100 });
    expect(rows.find((r) => r.id === 23)).toMatchObject({ imageId: 502, hidden: true });
    expect(rows.find((r) => r.id === 12)).toMatchObject({ imageId: 501, deleted: true });
    expect(rows.find((r) => r.id === 11)).toMatchObject({ authorIsReportedUser: false });
    expect(rows.find((r) => r.id === 22)).toMatchObject({ authorIsReportedUser: true });
  });

  it("adds the post's storyline text items to its text, in reading order", async () => {
    await db.pg.exec(`
      INSERT INTO "PostText" VALUES (1, 100, 5, '<p>second</p>'), (2, 100, 1, '<p>first</p>'),
        (3, 100, 9, '');
    `);
    const { candidates } = await getCsamContextCandidates({ userId: OWNER, imageIds: [501] });

    expect(candidates.find((r) => r.source === 'postDescription')?.text).toBe(
      'caption & more\n\nfirst\n\nsecond'
    );
  });

  it('says more comments exist past the page size, listing each once', async () => {
    await db.pg.exec(`
      INSERT INTO "CommentV3" SELECT g, 'image', 502, ${OTHER}, 'c' || g, '2026-10-01', NULL, false
        FROM generate_series(1000, 1600) g;
    `);
    const { candidates, more } = await getCsamContextCandidates({ userId: OWNER, imageIds: [502] });
    const commentIds = candidates.filter((c) => c.source === 'comment').map((c) => c.id);

    expect(new Set(commentIds).size).toBe(commentIds.length);
    expect(more).toBe(true);
  });

  it("lists nothing from another account's images", async () => {
    const { candidates } = await getCsamContextCandidates({ userId: OWNER, imageIds: [601] });

    expect(candidates).toEqual([]);
  });

  it('previews a long text and says how long it is', async () => {
    await db.pg.query(`UPDATE "Post" SET detail = $1 WHERE id = 100`, ['y'.repeat(5000)]);
    const {
      candidates: [post],
    } = await getCsamContextCandidates({ userId: OWNER, imageIds: [501] });

    expect(post).toMatchObject({ source: 'postDescription', fullLength: 5000 });
    expect(post.text).toHaveLength(2000);
  });

  it('keeps a link target beside its text', async () => {
    await db.pg.query(`UPDATE "Post" SET detail = $1 WHERE id = 100`, [
      '<p>more <a href="https://example.invalid/x">here</a></p>',
    ]);
    const {
      candidates: [post],
    } = await getCsamContextCandidates({ userId: OWNER, imageIds: [501] });

    expect(post.text).toBe('more here [https://example.invalid/x]');
  });
});

describe('snapshot', () => {
  const snapshot = (sources: { postIds: number[]; commentIds: number[] }, userIds = [OWNER]) =>
    snapshotCsamContextText({
      imageIds: [501, 502],
      sources,
      reportedUserIds: userIds,
      capturedById: MOD,
      capturedAt: at(8),
    }).then((r) => r.contextText);

  it('copies only what was ticked, with who wrote it', async () => {
    const rows = await snapshot({ postIds: [100], commentIds: [11, 22] });

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'postDescription',
          id: 100,
          authorId: OWNER,
          authorIsReportedUser: true,
          text: 'caption & more',
          capturedById: MOD,
          capturedAt: at(8).toISOString(),
        }),
        expect.objectContaining({ id: 11, authorId: OTHER, authorIsReportedUser: false }),
        expect.objectContaining({ id: 22, authorId: OWNER, authorIsReportedUser: true }),
      ])
    );
    expect(rows).toHaveLength(3);
  });

  it.each([
    ['a comment on a post outside the report', { postIds: [], commentIds: [13] }],
    ['a post outside the report', { postIds: [200], commentIds: [] }],
    ['an id that does not exist', { postIds: [], commentIds: [999] }],
    ['a comment on a post whose id is a report image id', { postIds: [], commentIds: [14] }],
  ])('refuses %s', async (_, sources) => {
    await expect(snapshot(sources)).rejects.toThrow(/not on the images in this report/);
  });

  it("refuses text on another account's image named in the filing", async () => {
    await expect(
      snapshotCsamContextText({
        imageIds: [501, 601],
        ownerId: OWNER,
        sources: { postIds: [200], commentIds: [] },
        reportedUserIds: [OWNER],
        capturedById: MOD,
      })
    ).rejects.toThrow(/not on the images in this report/);
  });

  it('copies no comment when only a post description is ticked', async () => {
    const rows = await snapshot({ postIds: [100], commentIds: [] });

    expect(ids(rows)).toEqual(['postDescription:100']);
  });

  it("counts the report's secondary user as the reported account", async () => {
    const userIds = reportedUserIdsOf(OWNER, { secondaryUserId: OTHER });
    const rows = await snapshot({ postIds: [], commentIds: [11] }, userIds);

    expect(userIds).toEqual([OWNER, OTHER]);
    expect(rows[0]).toMatchObject({ authorId: OTHER, authorIsReportedUser: true });
  });

  it('names no reported user for an internal report or a malformed secondary id', () => {
    expect(reportedUserIdsOf(-1, {})).toEqual([]);
    expect(reportedUserIdsOf(OWNER, { secondaryUserId: 'x' })).toEqual([OWNER]);
    expect(reportedUserIdsOf(OWNER, { secondaryUserId: SECONDARY })).toEqual([OWNER, SECONDARY]);
  });
});

describe('fold', () => {
  const capture = (id: number, text: string, day: number) =>
    ({ source: 'postText', id, text, capturedAt: at(day).toISOString() } as CsamPostContextText);

  it('keeps an earlier capture as it was and adds a later capture of the same item with new text', () => {
    const first = capture(7, 'first', 8);
    const before = structuredClone(first);
    const edited = capture(7, 'edited later', 12);
    const other = capture(8, 'new', 12);

    const prior = [first];
    expect(foldContextText(prior, [edited, other])).toEqual([first, edited, other]);
    expect(first).toEqual(before);
    expect(prior).toEqual([first]);
    expect(foldContextText(undefined, undefined)).toBeUndefined();
  });

  it('adds an item changed back to an earlier text, and skips text equal to its latest capture', () => {
    const a = capture(7, 'text A', 8);
    const b = capture(7, 'text B', 10);
    const aAgain = capture(7, 'text A', 12);
    const heard: CsamContextText[] = [];
    expect(foldContextText([a, b], [aAgain], (c) => heard.push(c))).toEqual([a, b, aAgain]);
    expect(heard).toEqual([]);

    const latestAgain = capture(7, 'text B', 12);
    expect(foldContextText([a, b], [latestAgain], (c) => heard.push(c))).toEqual([a, b]);
    expect(heard).toEqual([latestAgain]);
  });

  it('judges the latest capture by capture time, not by place in the list', () => {
    const b = capture(7, 'text B', 10);
    const a = capture(7, 'text A', 8);
    expect(foldContextText([b, a], [capture(7, 'text A', 12)])).toHaveLength(3);
    expect(foldContextText([b, a], [capture(7, 'text B', 12)])).toHaveLength(2);
  });

  describe('an identical capture with a review', () => {
    const review = (origin?: string) =>
      ({ byId: MOD, at: at(11).toISOString(), ...(origin && { origin }) } as CsamContextReview);
    const reviewed = (c: CsamPostContextText, r: CsamContextReview) => ({ ...c, reviewed: r });

    it.each(['filer-read', 'individual-decision'])(
      'marks the stored capture reviewed (%s), keeping its text and capture time',
      (origin) => {
        const stored = capture(7, 'same words', 8);
        const before = structuredClone(stored);
        const heard: [CsamContextText, CsamContextReview | undefined][] = [];
        const again = reviewed(capture(7, 'same words', 12), review(origin));

        const folded = foldContextText([stored], [again], (c, up) => heard.push([c, up]));

        expect(folded).toEqual([{ ...stored, reviewed: review(origin) }]);
        expect(stored).toEqual(before);
        expect(heard).toEqual([[again, review(origin)]]);
      }
    );

    it('changes nothing without a review, or with one that names no origin or an unknown one', () => {
      const stored = capture(7, 'same words', 8);
      const heard: (CsamContextReview | undefined)[] = [];
      expect(
        foldContextText([stored], [capture(7, 'same words', 12)], (_, up) => heard.push(up))
      ).toEqual([stored]);
      expect(
        foldContextText([stored], [reviewed(capture(7, 'same words', 12), review())], (_, up) =>
          heard.push(up)
        )
      ).toEqual([stored]);
      expect(
        foldContextText(
          [stored],
          [reviewed(capture(7, 'same words', 12), review('batched'))],
          (_, up) => heard.push(up)
        )
      ).toEqual([stored]);
      expect(heard).toEqual([undefined, undefined, undefined]);
    });

    it('never replaces or removes a stored review', () => {
      const earlier = { byId: OTHER, at: at(9).toISOString(), origin: 'filer-read' } as const;
      const stored = reviewed(capture(7, 'same words', 8), earlier);
      expect(
        foldContextText([stored], [reviewed(capture(7, 'same words', 12), review('filer-read'))])
      ).toEqual([stored]);
      expect(foldContextText([stored], [capture(7, 'same words', 12)])).toEqual([stored]);
    });

    it('marks only the latest capture, and only when its text matches', () => {
      const a = capture(7, 'text A', 8);
      const b = capture(7, 'text B', 10);
      const aAgain = reviewed(capture(7, 'text A', 12), review('filer-read'));
      expect(foldContextText([a, b], [aAgain])).toEqual([a, b, aAgain]);
    });
  });

  it('adds a capture whose text differs only in whitespace', () => {
    const first = capture(7, 'same words', 8);
    const spaced = capture(7, 'same  words ', 12);
    expect(foldContextText([first], [spaced])).toEqual([first, spaced]);
  });

  it('adds nothing for the same text captured again, in the report or within one filing', () => {
    const first = capture(7, 'same words', 8);
    expect(foldContextText([first], [capture(7, 'same words', 12)])).toEqual([first]);
    const twice = [capture(9, 'once', 12), capture(9, 'once', 12)];
    const heard: CsamContextText[] = [];
    expect(foldContextText([], twice, (c) => heard.push(c))).toEqual([twice[0]]);
    // A repeat within one filing is not a re-file of text the report held.
    expect(heard).toEqual([]);
    // The report's own text captured twice in one filing is heard once.
    const heardOnce: CsamContextText[] = [];
    foldContextText([first], [capture(7, 'same words', 12), capture(7, 'same words', 12)], (c) =>
      heardOnce.push(c)
    );
    expect(heardOnce).toHaveLength(1);
  });

  it('keeps the same text on another item or source as its own capture', () => {
    const first = capture(7, 'same words', 8);
    const comment = { ...capture(7, 'same words', 12), source: 'comment' } as CsamContextText;
    expect(foldContextText([first], [comment, capture(8, 'same words', 12)])).toHaveLength(3);
  });

  it('sends each capture of an edited item as its own page incident, at its capture time', () => {
    const base = {
      postId: 100,
      authorId: OWNER,
      authorIsReportedUser: true,
      postedAt: at(2).toISOString(),
      capturedById: MOD,
      reviewed: { byId: MOD, at: at(3).toISOString() },
    };
    const folded = foldContextText(
      [{ ...base, ...capture(7, 'the first text', 8) }],
      [{ ...base, ...capture(7, 'the edited text', 12) }]
    );
    const incidents = webPages(folded);
    expect(incidents).toHaveLength(2);
    expect(incidents[0].additionalInfo).toContain('the first text');
    expect(incidents[0].additionalInfo).not.toContain('the edited text');
    expect(incidents[1].additionalInfo).toContain('the edited text');
  });
});

describe('what NCMEC is sent', () => {
  const item = (fields: Record<string, unknown>) =>
    ({
      authorId: OWNER,
      authorIsReportedUser: true,
      postedAt: at(2).toISOString(),
      capturedAt: at(8).toISOString(),
      capturedById: MOD,
      ...fields,
    } as never);

  it('is one block per page, worded as Legal approved, naming no other account', () => {
    const [post, image] = webPages([
      item({
        source: 'comment',
        id: 11,
        postId: 100,
        authorId: OTHER,
        authorIsReportedUser: false,
        postedAt: at(3).toISOString(),
        text: 'a comment',
      }),
      item({ source: 'postDescription', id: 100, postId: 100, text: 'the caption' }),
      item({ source: 'comment', id: 23, imageId: 502, text: 'on the image' }),
    ]);

    expect(post).toEqual({
      url: `${RED}/posts/100`,
      additionalInfo: [
        'Text posted with the reported images on this page, captured by Civitai on 10/08/2026 14:05 UTC.',
        'Post description, posted 10/02/2026 14:05 UTC by the reported account:\n"the caption"',
        'Comment 11, posted 10/03/2026 14:05 UTC by another account:\n"a comment"',
      ].join('\n\n'),
    });
    expect(post.additionalInfo).not.toContain(String(OTHER));
    expect(image.url).toBe(`${RED}/images/502`);
  });

  it('splits a page captured at two times into one block per capture', () => {
    const blocks = webPages([
      item({ source: 'comment', id: 11, postId: 100, text: 'first' }),
      item({
        source: 'comment',
        id: 12,
        postId: 100,
        text: 'later',
        capturedAt: at(9).toISOString(),
      }),
    ]);

    expect(blocks.map((b) => b.url)).toEqual([`${RED}/posts/100`, `${RED}/posts/100`]);
    expect(blocks[0].additionalInfo).toContain('captured by Civitai on 10/08/2026');
    expect(blocks[0].additionalInfo).not.toContain('later');
    expect(blocks[1].additionalInfo).toContain('captured by Civitai on 10/09/2026');
  });

  it('sends an item of exactly the cap whole', () => {
    const exact = 'x'.repeat(CSAM_CONTEXT_TEXT_MAX_CHARS);
    const [incident] = webPages([item({ source: 'comment', id: 11, postId: 100, text: exact })]);

    expect(incident.additionalInfo).toContain(`"${exact}"`);
    expect(incident.additionalInfo).not.toContain('[Truncated');
  });

  it('truncates an item over the cap with the agreed line, counting characters not code units', () => {
    const long = '😀'.repeat(CSAM_CONTEXT_TEXT_MAX_CHARS + 7);
    const [incident] = webPages([item({ source: 'comment', id: 11, postId: 100, text: long })]);

    expect(incident.additionalInfo).toContain(
      `"${'😀'.repeat(
        CSAM_CONTEXT_TEXT_MAX_CHARS
      )}"\n[Truncated: 7 further characters are preserved by Civitai with this report.]`
    );
  });
});

describe('held text items', () => {
  const MOD_B = 11;
  // Item 1 is unheld; 2 has a Pending hold; 3 is held by its flag alone; 4's hold was confirmed
  // on its own, 5's in a batch.
  beforeEach(async () => {
    await db.pg.exec(`
      INSERT INTO "PostText" ("id", "postId", "index", "content", "csamHeld") VALUES
        (1, 100, 1, '<p>open words</p>', false), (2, 100, 2, '<p>pending words</p>', false),
        (3, 100, 3, '<p>flagged words</p>', true), (4, 100, 4, '<p>decided words</p>', true),
        (5, 100, 5, '<p>batched words</p>', true);
      INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "decidedById", "decidedAt", "meta", "createdAt", "updatedAt") VALUES
        ('PostText', 2, 'csam', 'Pending', NULL, NULL, '{}', '2026-10-03', '2026-10-03'),
        ('PostText', 4, 'csam', 'Confirmed', ${MOD_B}, '2026-10-04', '{"decision":"confirm","reviewedDecision":true}', '2026-10-03', '2026-10-04'),
        ('PostText', 5, 'csam', 'Confirmed', ${MOD_B}, '2026-10-04', '{"decision":"confirm","reviewedDecision":false}', '2026-10-03', '2026-10-04');
    `);
  });

  const snapshot = (capturedById = MOD, capturedAt = at(8)) =>
    snapshotCsamContextText({
      imageIds: [501],
      sources: { postIds: [100], commentIds: [] },
      reportedUserIds: [OWNER],
      capturedById,
      capturedAt,
    }).then((r) => r.contextText);
  const read = (postTextId: number, moderatorId = MOD) =>
    readHeldCsamContextText({ userId: OWNER, imageIds: [501], postTextId, moderatorId });
  const readAt = (postTextId: number, moderatorId: number, when: string) =>
    db.pg.query(
      `INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId", "createdAt")
       VALUES ($1, 'csamContextTextRead', 'PostText', $2, $3)`,
      [moderatorId, postTextId, when]
    );
  const byId = (rows: { source: string; id: number }[], id: number) =>
    rows.find((r) => r.source === 'postText' && r.id === id) as
      | { reviewed?: { byId: number; at: string }; text: string }
      | undefined;

  it('are captured on their own, not inside the post text, and their words are not previewed', async () => {
    const { candidates } = await getCsamContextCandidates({ userId: OWNER, imageIds: [501] });

    expect(candidates.find((r) => r.source === 'postDescription')?.text).toBe(
      'caption & more\n\nopen words'
    );
    expect(candidates.filter((r) => r.source === 'postText').map((r) => r.id)).toEqual([
      2, 3, 4, 5,
    ]);
    expect(candidates.filter((r) => r.source === 'postText').every((r) => r.text === '')).toBe(
      true
    );
  });

  it('go out marked not reviewed, unless confirmed on their own; filing alone marks nothing', async () => {
    const rows = await snapshot();

    expect(byId(rows, 2)?.reviewed).toBeUndefined();
    expect(byId(rows, 3)?.reviewed).toBeUndefined();
    expect(byId(rows, 5)?.reviewed).toBeUndefined();
    expect(byId(rows, 4)?.reviewed).toEqual({
      byId: MOD_B,
      at: at(4).toISOString().replace('14:05', '00:00'),
      origin: 'individual-decision',
    });
    const [incident] = webPages(rows);
    expect(incident.additionalInfo).toContain(
      `Text item 2 of this post, posted 10/02/2026 00:00 UTC by the reported account. Not reviewed by Civitai:\n"pending words"`
    );
    expect(incident.additionalInfo).toContain(
      'Text item 4 of this post, posted 10/02/2026 00:00 UTC by the reported account:\n"decided words"'
    );
    // Reading order: description, then items 2-5.
    expect(incident.additionalInfo.indexOf('pending words')).toBeLessThan(
      incident.additionalInfo.indexOf('batched words')
    );
  });

  it("are marked reviewed by the filing moderator's own read, with who and when", async () => {
    const result = await read(2);
    expect(result.text).toBe('pending words');

    const rows = await snapshot(MOD, new Date());
    expect(byId(rows, 2)?.reviewed).toEqual({ byId: MOD, at: result.readAt, origin: 'filer-read' });
    expect(webPages(rows)[0].additionalInfo).not.toContain(
      'Text item 2 of this post, posted 10/02/2026 00:00 UTC by the reported account. Not reviewed'
    );
  });

  it("are not marked reviewed by another moderator's read", async () => {
    await read(2, MOD_B);

    expect(byId(await snapshot(MOD, new Date()), 2)?.reviewed).toBeUndefined();
    expect(byId(await snapshot(MOD_B, new Date()), 2)?.reviewed).toMatchObject({ byId: MOD_B });
  });

  it('are not marked reviewed by a read from before the hold last changed, or after filing', async () => {
    await readAt(2, MOD, '2026-10-02 12:00');
    await readAt(3, MOD, '2026-10-09 12:00');

    const rows = await snapshot();
    expect(byId(rows, 2)?.reviewed).toBeUndefined();
    expect(byId(rows, 3)?.reviewed).toBeUndefined();
  });

  it('can be read only as held text on the report images', async () => {
    await expect(read(1)).rejects.toThrow(/not held text/);
    await expect(
      readHeldCsamContextText({ userId: OWNER, imageIds: [502], postTextId: 2, moderatorId: MOD })
    ).rejects.toThrow(/not held text/);
    const { rows } = await db.pg.query('SELECT 1 FROM "ModActivity"');
    expect(rows).toHaveLength(0);
  });

  it('leave their holds and flags as they were', async () => {
    const before = await db.pg.query('SELECT * FROM "TextScanHold" ORDER BY id');
    const flags = await db.pg.query('SELECT id, "csamHeld" FROM "PostText" ORDER BY id');
    await read(2);
    await snapshot();

    expect((await db.pg.query('SELECT * FROM "TextScanHold" ORDER BY id')).rows).toEqual(
      before.rows
    );
    expect((await db.pg.query('SELECT id, "csamHeld" FROM "PostText" ORDER BY id')).rows).toEqual(
      flags.rows
    );
  });

  it('let a post holding only held text be ticked, sending no empty description', async () => {
    await db.pg.exec(
      `UPDATE "Post" SET detail = NULL WHERE id = 100; DELETE FROM "PostText" WHERE id = 1;`
    );
    const { candidates } = await getCsamContextCandidates({ userId: OWNER, imageIds: [501] });
    expect(candidates.some((c) => c.source === 'postDescription' && c.id === 100)).toBe(true);

    const rows = await snapshot();
    expect(rows.some((r) => r.source === 'postDescription')).toBe(false);
    expect(rows.filter((r) => r.source === 'postText')).toHaveLength(4);
  });
});

describe('items the reported user wrote', () => {
  const SYSTEM = -1;
  beforeEach(async () => {
    auditLog([]);
    await db.pg.exec(
      `TRUNCATE "User", "UserProfile", "ChatMessage", "ChatMessageEdit", "Model", "ModelOwnership", "Article", "ServiceOffering";
       INSERT INTO "User" VALUES (${OWNER}, 'owner_name'), (${OTHER}, 'other'), (${SECONDARY}, 'second');
       INSERT INTO "UserProfile" VALUES
         (${OWNER}, 'red bio & <stuff>', 'hello there', '2026-10-03 14:05', 'clean bio', NULL, NULL);
       INSERT INTO "ChatMessage" VALUES
         (901, ${OWNER}, 'meet me <b>later</b>', 'Markdown', '2026-10-02 14:05', NULL, NULL),
         (902, ${OTHER}, 'not theirs', 'Markdown', '2026-10-02 14:05', NULL, NULL),
         (903, ${OWNER}, 'https://image.example/x.png', 'Image', '2026-10-02 14:05', NULL, NULL),
         (904, ${SYSTEM}, 'a system notice', 'Markdown', '2026-10-02 14:05', NULL, NULL),
         (905, ${OWNER}, 'changed words', 'Markdown', '2026-10-02 14:05', '2026-10-03 14:05', '2026-10-04 14:05'),
         (906, ${SECONDARY}, 'by the secondary user', 'Markdown', '2026-10-02 14:05', NULL, NULL);
       INSERT INTO "Model" VALUES
         (701, ${OWNER}, 'Model name', '<p>about <img src="https://img.example/a.png"></p>', 'Draft', '2026-10-01 14:05', NULL,
           'Com name', '<p>com <a href="https://x.example/c">about</a></p>'),
         (702, ${OTHER}, 'Other model', NULL, 'Published', '2026-10-01 14:05', NULL, NULL, NULL),
         (703, ${SECONDARY}, 'Secondary model', NULL, 'Published', '2026-10-01 14:05', NULL, NULL, NULL);
       INSERT INTO "Article" VALUES
         (801, ${OWNER}, 'Untitled draft', '', 'Draft', NULL),
         (802, ${OWNER}, 'Article title', '<p>body text</p>', 'Published', '2026-10-01 14:05');
       INSERT INTO "ServiceOffering" VALUES
         (1001, ${OWNER}, 'Offer title', 'plain <desc> & more', 'Paused', '2026-10-01 14:05');`
    );
  });

  const filing = (sources: Partial<CsamContextSources>, details?: unknown) =>
    snapshotCsamContextText({
      imageIds: [],
      ownerId: OWNER,
      sources: { postIds: [], commentIds: [], ...sources },
      reportedUserIds: reportedUserIdsOf(OWNER, details),
      capturedById: MOD,
      capturedAt: at(8),
    });
  const capture = (sources: Partial<CsamContextSources>, details?: unknown) =>
    filing(sources, details).then((r) => r.contextText);
  const notAttached = (sources: Partial<CsamContextSources>, details?: unknown) =>
    filing(sources, details).then((r) => r.notAttached);

  it('copies each type as one entry of labeled fields, with no post or image id', async () => {
    const rows = await capture({
      chatMessageIds: [901],
      modelIds: [701],
      articleIds: [802],
      serviceOfferingIds: [1001],
      profile: true,
    });

    expect(rows.map((r) => [r.source, r.id])).toEqual([
      ['chatMessage', 901],
      ['model', 701],
      ['article', 802],
      ['serviceOffering', 1001],
      ['profile', OWNER],
    ]);
    for (const row of rows) {
      expect(row).not.toHaveProperty('postId');
      expect(row).not.toHaveProperty('imageId');
      expect(row).toMatchObject({ authorId: OWNER, authorIsReportedUser: true, capturedById: MOD });
    }
    const [chat, model, article, offering, profile] = rows as CsamItemContextText[];
    expect(chat.fields).toEqual([{ label: 'Message', text: 'meet me <b>later</b>' }]);
    expect(model).toMatchObject({
      status: 'Draft',
      createdAt: at(1).toISOString(),
      fields: [
        { label: 'Name (civitai.red)', text: 'Model name' },
        { label: 'Description (civitai.red)', text: 'about [image: https://img.example/a.png]' },
        { label: 'Name (civitai.com)', text: 'Com name' },
        { label: 'Description (civitai.com)', text: 'com about [https://x.example/c]' },
      ],
    });
    expect(article.fields).toEqual([
      { label: 'Title', text: 'Article title' },
      { label: 'Content', text: 'body text' },
    ]);
    expect(offering).toMatchObject({
      status: 'Paused',
      fields: [
        { label: 'Title', text: 'Offer title' },
        { label: 'Description', text: 'plain <desc> & more' },
      ],
    });
    expect(profile).toMatchObject({
      username: 'owner_name',
      fields: [
        { label: 'Bio (civitai.red)', text: 'red bio & <stuff>' },
        {
          label: 'Message (civitai.red and civitai.com)',
          text: 'hello there',
          at: at(3).toISOString(),
        },
        { label: 'Bio (civitai.com)', text: 'clean bio' },
      ],
    });
    expect(profile.text).toBe(
      'Bio (civitai.red):\nred bio & <stuff>\n\nMessage (civitai.red and civitai.com):\nhello there\n\nBio (civitai.com):\nclean bio'
    );
  });

  it('captures no item a filing does not name', async () => {
    expect(await capture({})).toEqual([]);
  });

  it("files without a missing item or another account's, naming each the same way and copying neither", async () => {
    expect(await filing({ chatMessageIds: [999] })).toEqual({
      contextText: [],
      notAttached: ['chat message 999'],
    });
    expect(await filing({ chatMessageIds: [902] })).toEqual({
      contextText: [],
      notAttached: ['chat message 902'],
    });
    const mixed = await filing({ chatMessageIds: [901], modelIds: [702, 9999, 701] });
    expect(mixed.contextText.map((c) => `${c.source}:${c.id}`)).toEqual([
      'chatMessage:901',
      'model:701',
    ]);
    expect(mixed.notAttached).toEqual(['model 702', 'model 9999']);
  });

  it("does not attach the secondary user's items even when the report names one", async () => {
    const details = { secondaryUserId: SECONDARY };
    expect(reportedUserIdsOf(OWNER, details)).toContain(SECONDARY);
    expect(await filing({ chatMessageIds: [906], modelIds: [703] }, details)).toEqual({
      contextText: [],
      notAttached: ['chat message 906', 'model 703'],
    });
  });

  it('does not attach a system message, or a message that is not text', async () => {
    expect(await notAttached({ chatMessageIds: [904, 903] })).toEqual([
      'chat message 904',
      'chat message 903',
    ]);
  });

  it('does not attach a message anyone but its sender edited', async () => {
    await db.pg.exec(
      `INSERT INTO "ChatMessageEdit" ("messageId", "editorId") VALUES (905, ${OWNER}), (901, ${MOD})`
    );
    const { contextText, notAttached: refused } = await filing({ chatMessageIds: [901, 905] });
    expect(contextText.map((c) => c.id)).toEqual([905]);
    expect(refused).toEqual(['chat message 901']);
  });

  it('does not attach a model another account owned before, but does one only the placeholder held', async () => {
    await db.pg.exec(
      `INSERT INTO "Model" VALUES
         (704, ${OWNER}, 'Moved model', NULL, 'Published', '2026-10-01', NULL, NULL, NULL),
         (705, ${OWNER}, 'Restored model', NULL, 'Published', '2026-10-01', NULL, NULL, NULL);
       INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
         (701, ${OWNER}, 'create'),
         (704, ${OTHER}, 'create'), (704, ${OWNER}, 'transfer'),
         (705, ${OWNER}, 'create'), (705, -1, 'account-delete'), (705, ${OWNER}, 'restore');`
    );
    const { contextText, notAttached: refused } = await filing({ modelIds: [701, 704, 705] });
    expect(contextText.map((c) => c.id)).toEqual([701, 705]);
    expect(refused).toEqual(['model 704']);
  });

  it('keeps a deleted, edited message, saying both and that its text may differ from what was sent', async () => {
    // Its sender's edit is recorded, and the history was recorded from before it was sent.
    await db.pg.exec(
      `INSERT INTO "ChatMessageEdit" ("messageId", "editorId", "createdAt") VALUES (905, ${OWNER}, '2026-10-01 14:05')`
    );
    const log = auditLog([]);
    const [row] = await capture({ chatMessageIds: [905] });
    expect(log).not.toHaveBeenCalled();
    expect(row).toMatchObject({ editedAt: at(3).toISOString(), deletedAt: at(4).toISOString() });

    const {
      chatImIncidents: [incident],
      webPageIncidents,
    } = contextIncidents([row]);
    expect(webPageIncidents).toEqual([]);
    expect(incident).toEqual({
      chatClient: 'Civitai chat',
      content: 'Message:\n"changed words"',
      additionalInfo:
        'Text the reported user wrote in this chat message, captured by Civitai on 10/08/2026 14:05 UTC.\n' +
        'Chat message 905, sent 10/02/2026 14:05 UTC, deleted 10/04/2026 14:05 UTC, edited 10/03/2026 14:05 UTC: text as of capture; may differ from what was sent.',
    });
  });

  describe('an edited message whose recorded history may be incomplete', () => {
    const unconfirmed =
      "Text on the reported user's chat message as of capture. It was edited, and Civitai can't confirm who made every edit. Captured by Civitai on 10/08/2026 14:05 UTC.\n" +
      'Chat message 905, sent 10/02/2026 14:05 UTC, deleted 10/04/2026 14:05 UTC, edited 10/03/2026 14:05 UTC: text as of capture; may differ from what was sent.';
    const sentInfo = async () => {
      const { contextText, notAttached: refused } = await filing({ chatMessageIds: [905] });
      return {
        info: contextIncidents(contextText).chatImIncidents.map((i) => i.additionalInfo),
        refused,
      };
    };

    it('does not attach it when the audit log shows another account edited it', async () => {
      auditLog([
        { chatId: 1, messageId: 905, actorId: OWNER },
        { chatId: 1, messageId: 905, actorId: MOD },
      ]);
      expect(await sentInfo()).toEqual({ info: [], refused: ['chat message 905'] });
    });

    it('reads the log for a message sent before the history was recorded, even with a sender edit on record', async () => {
      await db.pg.exec(
        `INSERT INTO "ChatMessageEdit" ("messageId", "editorId", "createdAt") VALUES (905, ${OWNER}, '2026-10-05 14:05')`
      );
      auditLog([{ chatId: 1, messageId: 905, actorId: MOD }]);
      expect((await sentInfo()).refused).toEqual(['chat message 905']);
    });

    it('reads the log for an edited message with no recorded edit, even once the history is being recorded', async () => {
      await db.pg.exec(
        `INSERT INTO "ChatMessageEdit" ("messageId", "editorId", "createdAt") VALUES (901, ${OWNER}, '2026-09-01 14:05')`
      );
      auditLog([{ chatId: 1, messageId: 905, actorId: MOD }]);
      expect((await sentInfo()).refused).toEqual(['chat message 905']);
    });

    it("only counts the log's edits in the message's own chat", async () => {
      auditLog([{ chatId: 2, messageId: 905, actorId: MOD }]);
      expect(await sentInfo()).toEqual({ info: [unconfirmed], refused: [] });
    });

    it('attaches it, never worded as written by the user, when the log has no edit by anyone else', async () => {
      auditLog([{ chatId: 1, messageId: 905, actorId: OWNER }]);
      expect(await sentInfo()).toEqual({ info: [unconfirmed], refused: [] });
    });

    it('attaches it the same way when the log fails or is not configured', async () => {
      holder.clickhouse = { $query: () => Promise.reject(new Error('log down')) };
      expect(await sentInfo()).toEqual({ info: [unconfirmed], refused: [] });
      holder.clickhouse = undefined;
      expect(await sentInfo()).toEqual({ info: [unconfirmed], refused: [] });
    });

    it('does not wait on a log that never answers', async () => {
      holder.clickhouse = { $query: () => new Promise<never>(() => {}) };
      const started = Date.now();
      expect(await sentInfo()).toEqual({ info: [unconfirmed], refused: [] });
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  it('names a selected item with no text as not attached, and leaves an empty field out', async () => {
    await db.pg.exec(
      `UPDATE "UserProfile" SET bio = NULL, message = '  ', "sfwBio" = NULL, "sfwMessage" = NULL`
    );
    expect(await filing({ profile: true })).toEqual({ contextText: [], notAttached: ['profile'] });
    await db.pg.exec(
      `INSERT INTO "ChatMessage" VALUES (907, ${OWNER}, '   ', 'Markdown', '2026-10-02', NULL, NULL)`
    );
    const both = await filing({ chatMessageIds: [901, 907] });
    expect(both.contextText.map((c) => c.id)).toEqual([901]);
    expect(both.notAttached).toEqual(['chat message 907']);

    const [article] = (await capture({ articleIds: [801] })) as CsamItemContextText[];
    expect(article.fields).toEqual([{ label: 'Title', text: 'Untitled draft' }]);
    expect(article).not.toHaveProperty('createdAt');
  });

  it('adds nothing when an unchanged item is filed again, a four-field model and profile included', async () => {
    const sources = { chatMessageIds: [901], modelIds: [701], profile: true };
    const first = await capture(sources);
    const { contextText: again } = await snapshotCsamContextText({
      imageIds: [],
      ownerId: OWNER,
      sources: { postIds: [], commentIds: [], ...sources },
      reportedUserIds: [OWNER],
      capturedById: MOD,
      capturedAt: at(12),
    });
    await db.pg.exec(`UPDATE "UserProfile" SET "sfwMessage" = 'com message'`);
    const fourFields = await capture({ profile: true });
    expect((fourFields[0] as CsamItemContextText).fields).toHaveLength(4);
    const heard: string[] = [];

    const folded = foldContextText(first, again, (c) => heard.push(`${c.source}:${c.id}`));
    expect(folded).toEqual(first);
    expect(heard).toEqual(['chatMessage:901', 'model:701', `profile:${OWNER}`]);
    const refiled = foldContextText(foldContextText(first, fourFields), [
      { ...fourFields[0], capturedAt: at(20).toISOString() },
    ]);
    // The chat message, the model, and the profile before and after its fourth field was set.
    expect(refiled).toHaveLength(4);
  });

  it('stores items in the order the moderator picked them', async () => {
    const rows = await capture({
      chatMessageIds: [901],
      modelIds: [701],
      profile: true,
      order: ['profile', 'model:701', 'chatMessage:901'],
    });
    expect(rows.map((r) => r.source)).toEqual(['profile', 'model', 'chatMessage']);
  });

  it("lists the user's own items newest first, capped, and still files an id past the cap", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => 2000 + i);
    await db.pg.exec(
      `INSERT INTO "Model" VALUES ${ids
        .map((id) => `(${id}, ${OWNER}, 'm${id}', NULL, 'Published', '2026-10-01', NULL)`)
        .join(', ')}`
    );

    const { candidates, more } = await getCsamItemCandidates({ userId: OWNER, source: 'model' });
    expect(candidates).toHaveLength(100);
    expect(more).toBe(true);
    expect(candidates[0]).toEqual({
      source: 'model',
      id: 2100,
      title: 'm2100',
      status: 'Published',
    });
    expect(candidates.some((c) => c.id === 701 || c.id === 702)).toBe(false);

    const [unlisted] = await capture({ modelIds: [701] });
    expect(unlisted.id).toBe(701);
  });

  describe('what NCMEC is sent', () => {
    it('gives each web item its address and state at capture, never calling it posted or public', async () => {
      const rows = await capture({
        modelIds: [701],
        articleIds: [801],
        serviceOfferingIds: [1001],
      });
      const { webPageIncidents, chatImIncidents } = contextIncidents(rows);

      expect(chatImIncidents).toEqual([]);
      expect(webPageIncidents).toEqual([
        {
          url: `${RED}/models/701`,
          additionalInfo:
            "Text on the reported user's model as of capture, captured by Civitai on 10/08/2026 14:05 UTC.\n" +
            'Model 701, status Draft at capture, created 10/01/2026 14:05 UTC.\n\n' +
            'Name (civitai.red):\n"Model name"\n\nDescription (civitai.red):\n"about [image: https://img.example/a.png]"\n\n' +
            'Name (civitai.com):\n"Com name"\n\nDescription (civitai.com):\n"com about [https://x.example/c]"',
        },
        {
          url: `${RED}/articles/801`,
          additionalInfo:
            "Text on the reported user's article as of capture, captured by Civitai on 10/08/2026 14:05 UTC.\n" +
            'Article 801, status Draft at capture.\n\nTitle:\n"Untitled draft"',
        },
        {
          url: `${RED}/services/1001`,
          additionalInfo:
            "Text on the reported user's service offering as of capture, captured by Civitai on 10/08/2026 14:05 UTC.\n" +
            'Service offering 1001, status Paused at capture, created 10/01/2026 14:05 UTC.\n\n' +
            'Title:\n"Offer title"\n\nDescription:\n"plain <desc> & more"',
        },
      ]);
      for (const { additionalInfo } of webPageIncidents)
        expect(additionalInfo).not.toMatch(/posted|public/i);
    });

    it('treats an empty civitai.com override as an override', async () => {
      await db.pg.exec(`UPDATE "UserProfile" SET "sfwBio" = ''`);
      const [profile] = (await capture({ profile: true })) as CsamItemContextText[];
      expect(profile.fields.map((f) => f.label)).toEqual([
        'Bio (civitai.red)',
        'Message (civitai.red and civitai.com)',
      ]);
    });

    it('labels profile fields by site, with a time only where one is recorded', async () => {
      const {
        webPageIncidents: [incident],
      } = contextIncidents(await capture({ profile: true }));

      expect(incident).toEqual({
        url: `${RED}/user/owner_name`,
        additionalInfo:
          "Text on the reported user's profile as of capture, captured by Civitai on 10/08/2026 14:05 UTC.\n" +
          `Profile of the account reported in this CyberTip (user id ${OWNER}; username at capture owner_name). Profile links and images are not included.\n\n` +
          'Bio (civitai.red):\n"red bio & <stuff>"\n\n' +
          'Message (civitai.red and civitai.com), added 10/03/2026 14:05 UTC:\n"hello there"\n\n' +
          'Bio (civitai.com):\n"clean bio"',
      });
    });

    it('says a profile had no username at capture, and gives it no address', async () => {
      await db.pg.exec(`UPDATE "User" SET username = NULL WHERE id = ${OWNER}`);
      const {
        webPageIncidents: [incident],
      } = contextIncidents(await capture({ profile: true }));

      expect(incident).not.toHaveProperty('url');
      expect(incident.additionalInfo).toContain(
        `Profile of the account reported in this CyberTip (user id ${OWNER}; username at capture none).`
      );
    });

    it('sends items in stored order up to the send budget, so a profile picked first survives an overflow', async () => {
      const big = 'x'.repeat(CSAM_CONTEXT_TEXT_MAX_CHARS);
      const entry = (source: CsamItemContextText['source'], id: number): CsamItemContextText => ({
        source,
        id,
        authorId: OWNER,
        authorIsReportedUser: true,
        fields: [{ label: 'Name', text: big }],
        text: big,
        capturedAt: at(8).toISOString(),
        capturedById: MOD,
      });
      const models = Array.from({ length: CSAM_CONTEXT_ITEM_SELECT_LIMIT }, (_, i) =>
        entry('model', 3000 + i)
      );
      const post = {
        source: 'postDescription',
        id: 100,
        postId: 100,
        authorId: OWNER,
        authorIsReportedUser: true,
        postedAt: at(2).toISOString(),
        text: big,
        capturedAt: at(8).toISOString(),
        capturedById: MOD,
      } satisfies CsamPostContextText;

      const sent = contextIncidents([entry('profile', OWNER), ...models, post]);
      expect(sent.overBudget).toBe(1);
      const urls = sent.webPageIncidents.map((i) => i.url);
      // Post text is not counted against the item budget.
      expect(urls).toContain(`${RED}/posts/100`);
      expect(
        sent.webPageIncidents.some((i) => i.additionalInfo.includes("reported user's profile"))
      ).toBe(true);
      expect(urls).not.toContain(`${RED}/models/${3000 + CSAM_CONTEXT_ITEM_SELECT_LIMIT - 1}`);
      expect(urls).toContain(`${RED}/models/3000`);
    });

    it('sends at most the cap per item, across its fields', async () => {
      const long = 'x'.repeat(CSAM_CONTEXT_TEXT_MAX_CHARS - 10);
      await db.pg.query(`UPDATE "UserProfile" SET bio = $1, "sfwBio" = NULL`, [long]);
      const {
        webPageIncidents: [incident],
      } = contextIncidents(await capture({ profile: true }));

      expect(incident.additionalInfo).toContain(`Bio (civitai.red and civitai.com):\n"${long}"`);
      expect(incident.additionalInfo).toContain(
        'Message (civitai.red and civitai.com), added 10/03/2026 14:05 UTC:\n"hello ther"\n[Truncated: 1 further characters are preserved by Civitai with this report.]'
      );
    });
  });
});

describe('link targets in rich text', () => {
  const html =
    '<p>see <a href="https://x.example/a">this</a></p>' +
    '<img src="https://img.example/1.png">' +
    '<div data-type="embed"><iframe src="https://www.youtube.com/embed/abc"></iframe></div>' +
    '<edge-media url="abc-uuid" type="image"></edge-media>' +
    '<div data-type="blurb" data-id="77">blurb words</div>';

  it('keeps each target kind as text for the five item types', () => {
    const text = htmlToPlainText(html, { keepTargets: true });
    expect(text).toContain('see this [https://x.example/a]');
    expect(text).toContain('[image: https://img.example/1.png]');
    expect(text).toContain('[frame: https://www.youtube.com/embed/abc]');
    expect(text).toContain('[media: abc-uuid]');
    expect(text).toContain('blurb words [embed id: 77]');
  });

  it('keeps a target as written inside a heading, which converts its own text to upper case', () => {
    const text = htmlToPlainText(
      '<h1>title <img src="https://img.example/AbC.png"><edge-media url="MiXed"></edge-media></h1>' +
        '<h2><iframe src="https://v.example/XyZ"></iframe></h2>',
      { keepTargets: true }
    );
    expect(text).toContain('[image: https://img.example/AbC.png]');
    expect(text).toContain('[media: MiXed]');
    expect(text).toContain('[frame: https://v.example/XyZ]');
  });

  // Re-file folding and the holds queue compare this text with what earlier filings stored.
  it('leaves post and comment text exactly as before', () => {
    expect(htmlToPlainText(html)).toBe('see this [https://x.example/a]\n\n\nblurb words');
  });
});
