import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * What the image queues send for an image the media access rule (`restrictedImageIds`) withholds
 * from this moderator: the row with no key, and the control image beside it as it is. The withheld
 * image carries no mark of its own; a copy on its url is blocked as CSAM.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, downleveled } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  downleveled: { rows: [] as { imageId: number; originalLevel: number; createdAt: string }[] },
}));
const db_ = () => {
  if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
  return dbHandle.current;
};
vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return db_();
  },
  get dbWrite() {
    return db_();
  },
}));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => db_() }));
// ClickHouse is the boundary: the downleveled list's ids.
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    query: async () => ({ json: async () => downleveled.rows }),
  }),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const WITHHELD = 901;
const CONTROL = 902;
const COPY = 903;
const KEY = 'withheld-key';
const CONTROL_KEY = 'control-key';

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };

const SCHEMA = `${IMAGE_PAGES_SCHEMA}
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'PendingManualAssignment');
ALTER TABLE "Image" ALTER COLUMN ingestion DROP DEFAULT,
  ALTER COLUMN ingestion TYPE "ImageIngestionStatus" USING ingestion::"ImageIngestionStatus",
  ALTER COLUMN ingestion SET DEFAULT 'Scanned',
  ADD COLUMN "aiNsfwLevel" INTEGER;
ALTER TABLE "Tag" ADD COLUMN type TEXT;
ALTER TABLE "Model" ADD COLUMN name TEXT;
ALTER TABLE "ModelVersion" ADD COLUMN name TEXT;
CREATE TABLE "ImageRatingRequest" (
  "imageId" INTEGER, "userId" INTEGER, weight INTEGER, "nsfwLevel" INTEGER, status TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "TagsOnImageNew" ("imageId" INTEGER, "tagId" INTEGER, attributes INTEGER);
CREATE TABLE "TagsOnImageVote" ("imageId" INTEGER, "tagId" INTEGER, vote INTEGER);
CREATE TABLE "ModerationImageHelp" (
  id INTEGER PRIMARY KEY, "createdBy" TEXT, type TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "imageIds" JSONB, "isHandled" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "ImageRank" ("imageId" INTEGER, "reactionCountWeekRank" INTEGER);
CREATE TABLE "ComicProject" (
  id INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, name TEXT, status TEXT,
  "tosViolation" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "ComicChapter" ("projectId" INTEGER, position INTEGER, name TEXT, status TEXT);
CREATE TABLE "ComicPanel" (
  id INTEGER PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0, "chapterPosition" INTEGER NOT NULL,
  "projectId" INTEGER NOT NULL, prompt TEXT, "enhancedPrompt" TEXT, metadata JSONB, "imageId" INTEGER NOT NULL
);
CREATE TABLE "ModelVersionShowcaseItem" (
  "imageId" INTEGER, "modelVersionId" INTEGER, source TEXT, site TEXT, "addedById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), removed BOOLEAN NOT NULL DEFAULT false
);
`;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner');
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (50, 7, now() - interval '1 day');
    INSERT INTO "Image" (id, url, type, ingestion, "blockedFor", "nsfwLevel", "needsReview", meta, "userId", "postId") VALUES
      (${WITHHELD}, '${KEY}', 'image', 'Pending', NULL, 1, 'minor', '{"prompt": "withheld prompt"}', 7, 50),
      (${CONTROL}, '${CONTROL_KEY}', 'image', 'Pending', NULL, 1, 'minor', '{"prompt": "control prompt"}', 7, 50),
      (${COPY}, '${KEY}', 'image', 'Blocked', 'CSAM', 1, NULL, NULL, 7, NULL);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

type Row = Record<string, unknown>;
type User = { id: number; roles: string[] };

const run = async (
  route: Promise<{ load: (e: never) => unknown }>,
  path: string,
  user: User,
  params: Record<string, string> = {}
) => {
  const { load } = await route;
  return (await load({
    url: new URL(`http://moderator.test${path}`),
    params,
    locals: { user, grants: {} },
  } as never)) as Record<string, unknown>;
};

const scan = (rows: unknown, id: number, field = 'id') =>
  (rows as Row[]).find((r) => r[field] === id);

/** Each queue: its load, the rows it sends, and the field that names the image and its key. */
const queues: {
  name: string;
  seed: () => Promise<unknown>;
  load: (user: User) => Promise<Row[]>;
  idField?: string;
  urlField?: string;
}[] = [
  {
    name: '/images/downleveled',
    seed: async () => {
      downleveled.rows = [WITHHELD, CONTROL].map((imageId) => ({
        imageId,
        originalLevel: 4,
        createdAt: '2026-11-01 00:00:00',
      }));
    },
    load: async (user) =>
      (
        await run(
          import('../../../routes/images/downleveled/+page.server'),
          '/images/downleveled',
          user
        )
      ).items as Row[],
  },
  {
    name: '/images/ratings',
    seed: () =>
      db.exec(`INSERT INTO "ImageRatingRequest" ("imageId", weight, "nsfwLevel", status) VALUES
        (${WITHHELD}, 5, 4, 'Pending'), (${CONTROL}, 5, 4, 'Pending')`),
    load: async (user) =>
      (await run(import('../../../routes/images/ratings/+page.server'), '/images/ratings', user))
        .items as Row[],
  },
  {
    name: '/images/tags',
    seed: () =>
      db.exec(`INSERT INTO "TagsOnImageNew" ("imageId", "tagId", attributes) VALUES
        (${WITHHELD}, 1, ${1 << 9}), (${CONTROL}, 1, ${1 << 9})`),
    load: async (user) =>
      (await run(import('../../../routes/images/tags/+page.server'), '/images/tags', user))
        .items as Row[],
  },
  {
    name: '/images/to-ingest',
    seed: async () => undefined,
    load: async (user) =>
      (
        await run(
          import('../../../routes/images/to-ingest/+page.server'),
          '/images/to-ingest',
          user
        )
      ).images as Row[],
  },
  {
    name: '/retool/image-help',
    seed: () =>
      db.exec(`INSERT INTO "ModerationImageHelp" (id, "createdBy", type, "imageIds") VALUES
        (1, 'mod', 'Help', '[${WITHHELD}, ${CONTROL}]')`),
    load: async (user) =>
      (
        await run(
          import('../../../routes/retool/image-help/+page.server'),
          '/retool/image-help',
          user
        )
      ).images as Row[],
  },
  {
    name: '/retool/front-page-audit/image',
    seed: () =>
      db.exec(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id IN (${WITHHELD}, ${CONTROL})`),
    load: async (user) =>
      (
        await run(
          import('../../../routes/retool/front-page-audit/[media]/+page.server'),
          '/retool/front-page-audit/image?order=reactions&level=1',
          user,
          { media: 'image' }
        )
      ).items as Row[],
  },
  {
    name: '/comics-review',
    seed: () =>
      db.exec(`
        INSERT INTO "ComicProject" (id, "userId", name, status) VALUES (60, 7, 'comic', 'Active');
        INSERT INTO "ComicChapter" ("projectId", position, name, status) VALUES (60, 0, 'ch', 'Published');
        INSERT INTO "ComicPanel" (id, "chapterPosition", "projectId", prompt, "imageId") VALUES
          (61, 0, 60, 'withheld panel prompt', ${WITHHELD}), (62, 0, 60, 'control panel prompt', ${CONTROL});`),
    load: async (user) =>
      (await run(import('../../../routes/comics-review/+page.server'), '/comics-review', user))
        .items as Row[],
    idField: 'imageId',
    urlField: 'imageUrl',
  },
  {
    name: '/models/version-showcases',
    seed: () =>
      db.exec(`
        INSERT INTO "Model" (id, name) VALUES (70, 'model');
        INSERT INTO "ModelVersion" (id, name, "modelId") VALUES (71, 'v1', 70);
        INSERT INTO "ModelVersionShowcaseItem" ("imageId", "modelVersionId", source, site) VALUES
          (${WITHHELD}, 71, 'Community', 'com'), (${CONTROL}, 71, 'Community', 'com');`),
    load: async (user) =>
      (
        await run(
          import('../../../routes/models/version-showcases/+page.server'),
          '/models/version-showcases',
          user
        )
      ).items as Row[],
    idField: 'imageId',
    urlField: 'imageUrl',
  },
];

describe.each(queues)('$name', ({ seed, load, idField = 'id', urlField = 'url' }) => {
  beforeEach(async () => {
    await seed();
  });

  it('sends the withheld image with no key to a moderator without the grant', async () => {
    const rows = await load(WITHOUT_GRANT);
    const withheld = scan(rows, WITHHELD, idField);
    expect(withheld).toMatchObject({ [urlField]: '', restricted: true });
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(JSON.stringify(rows)).not.toContain('withheld');
  });

  it('sends the control image as it is', async () => {
    const rows = await load(WITHOUT_GRANT);
    expect(scan(rows, CONTROL, idField)).toMatchObject({ [urlField]: CONTROL_KEY });
  });

  it('sends the withheld image to a moderator with the grant', async () => {
    const rows = await load(WITH_GRANT);
    expect(scan(rows, WITHHELD, idField)).toMatchObject({ [urlField]: KEY });
  });
});

describe('/audit/generator-restrictions remix sources', () => {
  const sources = async (user: User) => {
    const { getRemixSources } = await import('../user-restriction.service');
    return getRemixSources([WITHHELD, CONTROL], user as never);
  };

  it('sends a withheld source with no key or prompt to a moderator without the grant', async () => {
    const rows = await sources(WITHOUT_GRANT);
    expect(scan(rows, WITHHELD)).toMatchObject({ url: '', prompt: null, restricted: true });
    expect(scan(rows, CONTROL)).toMatchObject({ url: CONTROL_KEY, prompt: 'control prompt' });
  });

  it('sends it to a moderator with the grant', async () => {
    expect(scan(await sources(WITH_GRANT), WITHHELD)).toMatchObject({ url: KEY });
  });
});
