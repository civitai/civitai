import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { recomputeArticleIngestionInTx } from '~/server/services/article.service';

/**
 * An article's Error episode through the ingestion recompute, against real Postgres rows: when it
 * starts (and tells the owner), how it survives the Pending a retry round brings, and how it ends.
 * Ids are invented.
 */

const ARTICLE = 40;
const OWNER = 7;
const COVER = 50;
const CONTENT = 51;

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'UnpublishedViolation', 'Processing');
    CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "EntityModerationStatus" AS ENUM ('Pending', 'Succeeded', 'Failed', 'Expired', 'Canceled');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1,
      "blockedFor" text, "needsReview" text
    );
    CREATE TABLE "ImageConnection" ("imageId" int NOT NULL, "entityId" int NOT NULL, "entityType" text NOT NULL,
      PRIMARY KEY ("imageId", "entityType", "entityId"));
    CREATE TABLE "Article" (
      id int PRIMARY KEY, title text NOT NULL, content text NOT NULL, "userId" int NOT NULL,
      "publishedAt" timestamp(3), status "ArticleStatus" NOT NULL, ingestion "ArticleIngestionStatus" NOT NULL,
      "coverId" int, "bannerId" int, "moderatorNsfwLevel" int, metadata jsonb, "contentScannedAt" timestamp(3)
    );
    CREATE TABLE "EntityModeration" (
      id serial PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
      status "EntityModerationStatus" NOT NULL, blocked boolean, "contentHash" text, result jsonb,
      "updatedAt" timestamp(3) NOT NULL DEFAULT now(), UNIQUE ("entityType", "entityId")
    );
    CREATE TABLE "ArticleContentLinkHold" (
      "articleId" int PRIMARY KEY, deferred text[] NOT NULL DEFAULT '{}', refused text[] NOT NULL DEFAULT '{}',
      "editorId" int NOT NULL, "deferredSince" timestamp(3), "reportedAt" timestamp(3)
    );
  `);
}, 60_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await h.pg.exec(
    `TRUNCATE "Image", "ImageConnection", "Article", "EntityModeration", "ArticleContentLinkHold"`
  );
});

type Img = { ingestion: string; needsReview?: string; blockedFor?: string };

const seed = async ({
  status = 'Published',
  ingestion = 'Pending',
  metadata = {},
  cover = { ingestion: 'Scanned' },
  content,
  /** The title; empty leaves the article with no text to check. */
  text = '',
  textStatus,
  moderatorNsfwLevel = null,
}: {
  status?: string;
  ingestion?: string;
  metadata?: object;
  cover?: Img;
  content?: Img;
  text?: string;
  textStatus?: string;
  moderatorNsfwLevel?: number | null;
}) => {
  const images: [number, Img][] = [[COVER, cover]];
  if (content) images.push([CONTENT, content]);
  for (const [id, img] of images)
    await h.pg.query(
      `INSERT INTO "Image" (id, ingestion, "blockedFor", "needsReview") VALUES ($1, $2, $3, $4)`,
      [id, img.ingestion, img.blockedFor ?? null, img.needsReview ?? null]
    );
  if (content)
    await h.pg.query(`INSERT INTO "ImageConnection" VALUES ($1, $2, 'Article')`, [
      CONTENT,
      ARTICLE,
    ]);
  await h.pg.query(
    `INSERT INTO "Article" (id, title, content, "userId", "publishedAt", status, ingestion, "coverId", "moderatorNsfwLevel", metadata)
     VALUES ($1, $2, '', $3, now(), $4, $5, $6, $7, $8)`,
    [ARTICLE, text, OWNER, status, ingestion, COVER, moderatorNsfwLevel, JSON.stringify(metadata)]
  );
  if (textStatus)
    await h.pg.query(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", status) VALUES ('Article', $1, $2)`,
      [ARTICLE, textStatus]
    );
};

const recompute = async () => {
  const result = await h.prisma.$transaction((tx) =>
    recomputeArticleIngestionInTx(tx as Prisma.TransactionClient, ARTICLE)
  );
  const {
    rows: [row],
  } = await h.pg.query<{ ingestion: string; metadata: { ingestionError?: object } | null }>(
    `SELECT ingestion, metadata FROM "Article" WHERE id = $1`,
    [ARTICLE]
  );
  return { ...row, notice: result.ingestionErrorNotification ?? null };
};

const EPISODE = { ingestionError: { enteredAt: 1_700_000_000_000, rounds: 1 } };

describe('an Error episode starting', () => {
  it('records the episode and tells the owner what could not be scanned', async () => {
    await seed({ content: { ingestion: 'Error' } });

    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    expect(after.metadata?.ingestionError).toEqual({ enteredAt: expect.any(Number), rounds: 0 });
    expect(after.notice).toMatchObject({
      userId: OWNER,
      reason: '1 image(s) could not be scanned',
      imageProblem: true,
    });
  });

  it('names a failed text check when the images are fine', async () => {
    await seed({ text: 'Some words', textStatus: 'Failed' });

    expect((await recompute()).notice).toMatchObject({
      reason: 'the text check could not finish',
      imageProblem: false,
    });
  });

  it('says nothing to the owner while another image awaits review', async () => {
    await seed({ cover: { ingestion: 'Scanned', needsReview: 'minor' }, content: { ingestion: 'Error' } });

    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    expect(after.notice).toBeNull();
  });

  it('records a Processing article but leaves its owner to the cannot-publish notice', async () => {
    await seed({ status: 'Processing', content: { ingestion: 'Error' } });

    const after = await recompute();

    expect(after.metadata?.ingestionError).toBeDefined();
    expect(after.notice).toBeNull();
  });
});

describe('an Error episode under way', () => {
  it('neither restarts nor re-notifies when a retry round brought the article back through Pending', async () => {
    await seed({ ingestion: 'Pending', metadata: EPISODE, content: { ingestion: 'Error' } });

    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    expect(after.metadata).toEqual(EPISODE);
    expect(after.notice).toBeNull();
  });
});

// Moderation Lead condition 2, scope A (2026-11-26): the hold applies at the way out of Error only.
describe('an Error episode ending', () => {
  it('goes public, and drops the episode, once every image is scanned', async () => {
    await seed({ ingestion: 'Error', metadata: EPISODE, content: { ingestion: 'Scanned' } });

    const after = await recompute();

    expect(after.ingestion).toBe('Scanned');
    expect(after.metadata).toEqual({});
  });

  it('stays hidden while a scanned image awaits review', async () => {
    await seed({
      ingestion: 'Error',
      metadata: EPISODE,
      content: { ingestion: 'Scanned', needsReview: 'minor' },
    });

    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    expect(after.metadata).toEqual(EPISODE);
  });

  it('stays hidden past a moderator rating while an image keeps its block reason', async () => {
    await seed({
      ingestion: 'Error',
      metadata: EPISODE,
      moderatorNsfwLevel: 1,
      content: { ingestion: 'Error', blockedFor: 'tos' },
    });

    expect((await recompute()).ingestion).toBe('Error');
  });

  it('still publishes an article outside an Error episode while an image awaits review', async () => {
    await seed({ ingestion: 'Pending', content: { ingestion: 'Scanned', needsReview: 'minor' } });

    expect((await recompute()).ingestion).toBe('Scanned');
  });
});
