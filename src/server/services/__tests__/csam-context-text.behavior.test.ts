import { PGlite } from '@electric-sql/pglite';
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

const holder = vi.hoisted(() => {
  process.env.SERVER_DOMAIN_RED = 'red.example.invalid';
  return { kysely: null as unknown };
});
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
  get kyselyV3Read() {
    return holder.kysely;
  },
}));

const {
  getCsamContextCandidates,
  snapshotCsamContextText,
  reportedUserIdsOf,
  foldContextText,
  contextWebPageIncidents,
  CSAM_CONTEXT_TEXT_MAX_CHARS,
} = await import('~/server/services/csam-context-text');
const RED = 'https://red.example.invalid';

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
  "id" INTEGER PRIMARY KEY, "postId" INTEGER NOT NULL, "index" INTEGER NOT NULL, "content" TEXT NOT NULL
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
    `TRUNCATE "Post", "Image", "CommentV3", "PostText";
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
    });

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
  it('keeps the first capture of a source and adds new ones', () => {
    const first = { source: 'comment', id: 11, text: 'first' } as never;
    const again = { source: 'comment', id: 11, text: 'edited later' } as never;
    const other = { source: 'comment', id: 12, text: 'new' } as never;

    expect(foldContextText([first], [again, other])).toEqual([first, other]);
    expect(foldContextText(undefined, undefined)).toBeUndefined();
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
    const [post, image] = contextWebPageIncidents([
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
    const blocks = contextWebPageIncidents([
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
    const [incident] = contextWebPageIncidents([
      item({ source: 'comment', id: 11, postId: 100, text: exact }),
    ]);

    expect(incident.additionalInfo).toContain(`"${exact}"`);
    expect(incident.additionalInfo).not.toContain('[Truncated');
  });

  it('truncates an item over the cap with the agreed line, counting characters not code units', () => {
    const long = '😀'.repeat(CSAM_CONTEXT_TEXT_MAX_CHARS + 7);
    const [incident] = contextWebPageIncidents([
      item({ source: 'comment', id: 11, postId: 100, text: long }),
    ]);

    expect(incident.additionalInfo).toContain(
      `"${'😀'.repeat(
        CSAM_CONTEXT_TEXT_MAX_CHARS
      )}"\n[Truncated: 7 further characters are preserved by Civitai with this report.]`
    );
  });
});
