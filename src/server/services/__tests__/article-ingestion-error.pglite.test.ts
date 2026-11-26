import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { TEXT_MODERATION_RETRY_LIMIT } from '~/server/jobs/text-moderation-retry.constants';
import {
  markArticleForRescan,
  recomputeArticleIngestionInTx,
} from '~/server/services/article.service';

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
      "coverId" int, "bannerId" int, "moderatorNsfwLevel" int, metadata jsonb, "contentScannedAt" timestamp(3),
      "scanRequestedAt" timestamp(3)
    );
    CREATE TABLE "EntityModeration" (
      id serial PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
      status "EntityModerationStatus" NOT NULL, blocked boolean, "contentHash" text, result jsonb,
      "retryCount" int NOT NULL DEFAULT 0,
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
  textRetries = 0,
  moderatorNsfwLevel = null,
  deferredUrls,
}: {
  status?: string;
  ingestion?: string;
  metadata?: object;
  cover?: Img;
  content?: Img;
  text?: string;
  textStatus?: string;
  textRetries?: number;
  moderatorNsfwLevel?: number | null;
  deferredUrls?: string[];
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
      `INSERT INTO "EntityModeration" ("entityType", "entityId", status, "retryCount") VALUES ('Article', $1, $2, $3)`,
      [ARTICLE, textStatus, textRetries]
    );
  if (deferredUrls)
    await h.pg.query(
      `INSERT INTO "ArticleContentLinkHold" ("articleId", deferred, "editorId") VALUES ($1, $2, $3)`,
      [ARTICLE, deferredUrls, OWNER]
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

// An episode whose owner was already told.
const EPISODE = {
  ingestionError: { enteredAt: 1_700_000_000_000, rounds: 1, notifiedAt: 1_700_000_000_000 },
};

// Notification policy agreed with the Moderation Lead and the Site Maintenance Lead (#10522).
describe('an Error episode starting', () => {
  it('records the episode and tells the owner what could not be scanned', async () => {
    await seed({ content: { ingestion: 'Error' } });

    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    const episode = after.metadata?.ingestionError as { enteredAt: number; notifiedAt: number };
    expect(episode).toEqual({
      enteredAt: expect.any(Number),
      rounds: 0,
      notifiedAt: expect.any(Number),
    });
    expect(Date.now() - episode.enteredAt).toBeLessThan(60_000);
    expect(after.notice).toEqual({
      userId: OWNER,
      title: '',
      reason: '1 image(s) could not be scanned',
      imageProblem: true,
      enteredAt: episode.enteredAt,
    });
  });

  it('tells the owner nothing more on a later recompute in the same episode', async () => {
    await seed({ ingestion: 'Pending', content: { ingestion: 'Error' } });
    await recompute();

    expect((await recompute()).notice).toBeNull();
  });

  it('names a failed text check once the retry job has given up on it', async () => {
    await seed({
      text: 'Some words',
      textStatus: 'Failed',
      textRetries: TEXT_MODERATION_RETRY_LIMIT,
    });

    expect((await recompute()).notice).toMatchObject({
      reason: 'the text check could not finish',
      imageProblem: false,
    });
  });

  it('waits to tell the owner while the retry job is still retrying the text check', async () => {
    await seed({ text: 'Some words', textStatus: 'Failed', textRetries: 1 });

    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    expect(after.metadata?.ingestionError).toEqual({ enteredAt: expect.any(Number), rounds: 0 });
    expect(after.notice).toBeNull();
  });

  it('says nothing to the owner while a content url is held', async () => {
    await seed({ content: { ingestion: 'Error' }, deferredUrls: ['https://example.com/a.png'] });

    expect((await recompute()).notice).toBeNull();
  });

  it('records no episode for a draft', async () => {
    await seed({ status: 'Draft', content: { ingestion: 'Error' } });

    expect((await recompute()).metadata).toEqual({});
  });

  it('says nothing to the owner while another image awaits review', async () => {
    await seed({
      cover: { ingestion: 'Scanned', needsReview: 'minor' },
      content: { ingestion: 'Error' },
    });

    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    expect(after.notice).toBeNull();
  });

  it('records a Processing article but leaves its owner to the cannot-publish notice', async () => {
    await seed({ status: 'Processing', content: { ingestion: 'Error' } });

    const after = await recompute();

    expect(after.metadata?.ingestionError).toEqual({ enteredAt: expect.any(Number), rounds: 0 });
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

  it('tells the owner once the text check it was waiting on gives up', async () => {
    const waiting = { ingestionError: { enteredAt: 1_700_000_000_000, rounds: 0 } };
    await seed({
      ingestion: 'Error',
      metadata: waiting,
      text: 'Some words',
      textStatus: 'Failed',
      textRetries: TEXT_MODERATION_RETRY_LIMIT,
    });

    expect((await recompute()).notice).toMatchObject({
      reason: 'the text check could not finish',
      enteredAt: 1_700_000_000_000,
    });
  });

  it('never tells the owner of an episode recorded after the fact', async () => {
    const silent = { ingestionError: { enteredAt: 1_700_000_000_000, rounds: 1, silent: true } };
    await seed({ ingestion: 'Pending', metadata: silent, content: { ingestion: 'Error' } });

    expect((await recompute()).notice).toBeNull();
  });
});

// Agreed with the Moderation Lead (#10522): the hold applies only while an Error episode lasts.
describe('an Error episode ending', () => {
  it('goes public, and drops the episode, once every image is scanned', async () => {
    await seed({ ingestion: 'Error', metadata: EPISODE, content: { ingestion: 'Scanned' } });

    const after = await recompute();

    expect(after.ingestion).toBe('Scanned');
    expect(after.metadata).toEqual({});
  });

  it('drops the episode when the article is blocked', async () => {
    await seed({ ingestion: 'Error', metadata: EPISODE, content: { ingestion: 'Blocked' } });

    const after = await recompute();

    expect(after.ingestion).toBe('Blocked');
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

describe('an article at Error from before episodes were recorded', () => {
  it('gets a silent episode when it leaves Error for Pending, and stays hidden past a held image', async () => {
    await seed({ ingestion: 'Error', content: { ingestion: 'Rescan' } });

    const pending = await recompute();
    expect(pending.ingestion).toBe('Pending');
    expect(pending.metadata?.ingestionError).toMatchObject({ silent: true });

    await h.pg.query(
      `UPDATE "Image" SET ingestion = 'Scanned', "needsReview" = 'minor' WHERE id = $1`,
      [CONTENT]
    );
    expect((await recompute()).ingestion).toBe('Error');
  });

  it('gets a silent episode while it stays at Error, and its owner is not told', async () => {
    await seed({ ingestion: 'Error', content: { ingestion: 'Error' } });

    const after = await recompute();

    expect(after.metadata?.ingestionError).toMatchObject({ silent: true });
    expect(after.notice).toBeNull();
  });
});

describe('a rescan of an article at Error that has no recorded episode', () => {
  const rescanWrite = () => markArticleForRescan(h.prisma, ARTICLE);

  it('stays hidden while a scanned image awaits review', async () => {
    await seed({ ingestion: 'Error', content: { ingestion: 'Scanned', needsReview: 'minor' } });

    await rescanWrite();
    const after = await recompute();

    expect(after.ingestion).toBe('Error');
    expect(after.metadata?.ingestionError).toMatchObject({ silent: true });
  });

  it('keeps an episode it already has', async () => {
    await seed({ ingestion: 'Error', metadata: EPISODE, content: { ingestion: 'Error' } });

    await rescanWrite();

    expect((await recompute()).metadata).toEqual(EPISODE);
  });
});
