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

const holder = vi.hoisted(() => ({ kysely: null as unknown }));
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
const { getBaseUrl } = await import('~/server/utils/url-helpers');

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
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "postId" INTEGER);
CREATE TABLE "Thread" (
  "id" INTEGER PRIMARY KEY, "postId" INTEGER, "imageId" INTEGER, "rootThreadId" INTEGER
);
CREATE TABLE "CommentV2" (
  "id" INTEGER PRIMARY KEY, "threadId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
  "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL, "hidden" BOOLEAN DEFAULT false
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
    `TRUNCATE "Post", "Image", "Thread", "CommentV2", "CommentV3";
     INSERT INTO "Post" VALUES (100, ${OWNER}, '<p>caption &amp; <b>more</b></p>', '2026-10-01', '2026-10-02 08:30');
     INSERT INTO "Post" VALUES (200, ${OTHER}, '<p>unrelated post</p>', '2026-10-01', NULL);
     INSERT INTO "Image" VALUES (501, 100), (502, NULL), (601, 200);
     INSERT INTO "Thread" VALUES (1, 100, NULL, NULL), (2, NULL, 502, NULL), (3, NULL, NULL, 1), (4, 200, NULL, NULL);
     INSERT INTO "CommentV3" VALUES
       (11, 'post', 100, ${OTHER}, '<p>v3 on the post</p>', '2026-10-03', NULL, false),
       (12, 'image', 501, ${OWNER}, 'v3 on the image', '2026-10-04', '2026-10-05', false),
       (13, 'post', 200, ${OWNER}, 'v3 on an unrelated post', '2026-10-04', NULL, false),
       (21, 'post', 100, ${OTHER}, 'mirrored copy of 21', '2026-10-03', NULL, false);
     INSERT INTO "CommentV2" VALUES
       (21, 1, ${OTHER}, 'v2 original of 21', '2026-10-03', false),
       (22, 3, ${OWNER}, 'v2 reply in the post thread', '2026-10-06', false),
       (23, 2, ${OTHER}, 'v2 on the loose image', '2026-10-07', true),
       (24, 4, ${OTHER}, 'v2 on an unrelated post', '2026-10-07', false);`
  );
});

const ids = (rows: { source: string; id: number }[]) =>
  rows.map((r) => `${r.source}:${r.id}`).sort();

describe('candidates', () => {
  it("lists the images' post descriptions and comments from both tables, each once", async () => {
    const rows = await getCsamContextCandidates({ imageIds: [501, 502] });

    expect(ids(rows)).toEqual(
      [
        'postDescription:100',
        'comment:11',
        'comment:12',
        'comment:21',
        'comment:22',
        'comment:23',
      ].sort()
    );
    expect(rows.find((r) => r.id === 21)?.text).toBe('mirrored copy of 21');
    expect(rows.find((r) => r.source === 'postDescription')?.text).toBe('caption & more');
    expect(rows.find((r) => r.id === 22)).toMatchObject({ postId: 100 });
    expect(rows.find((r) => r.id === 23)).toMatchObject({ imageId: 502, hidden: true });
    expect(rows.find((r) => r.id === 12)).toMatchObject({ imageId: 501, deleted: true });
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
    ['a V2 comment on a post outside the report', { postIds: [], commentIds: [24] }],
    ['a post outside the report', { postIds: [200], commentIds: [] }],
    ['an id that does not exist', { postIds: [], commentIds: [999] }],
  ])('refuses %s', async (_, sources) => {
    await expect(snapshot(sources)).rejects.toThrow(/not on the images in this report/);
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
      url: `${getBaseUrl()}/posts/100`,
      additionalInfo: [
        'Text posted with the reported images on this page, captured by Civitai on 10/08/2026 14:05 UTC.',
        'Post description, posted 10/02/2026 14:05 UTC by the reported account:\n"the caption"',
        'Comment 11, posted 10/03/2026 14:05 UTC by another account:\n"a comment"',
      ].join('\n\n'),
    });
    expect(post.additionalInfo).not.toContain(String(OTHER));
    expect(image.url).toBe(`${getBaseUrl()}/images/502`);
  });

  it('truncates an item over the cap with the agreed line, counting characters not code units', () => {
    const long = '😀'.repeat(CSAM_CONTEXT_TEXT_MAX_CHARS + 7);
    const [incident] = contextWebPageIncidents([
      item({ source: 'comment', id: 11, postId: 100, text: long }),
    ]);

    expect(incident.additionalInfo).toContain(
      `"${'😀'.repeat(
        CSAM_CONTEXT_TEXT_MAX_CHARS
      )}\n[Truncated: 7 further characters are preserved by Civitai with this report.]"`
    );
  });
});
