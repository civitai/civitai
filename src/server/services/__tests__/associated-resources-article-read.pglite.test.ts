import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  articleReadableWhere,
  canReadArticle,
  canViewArticle,
  type ArticleReader,
} from '~/server/services/article-read';
import {
  getAssociatedResourcesSimple,
  setAssociatedResources,
} from '~/server/services/model.service';
import type { SessionUser } from '~/types/session';

const OWNER = 7;
const MODEL = 100;
const MODEL_OWNER = 20;
const OTHER_MODEL = 200;

// One article per state the read rule distinguishes.
const ARTICLES = {
  live: {
    id: 1,
    status: 'Published',
    ingestion: 'Scanned',
    published: true,
    availability: 'Public',
  },
  draft: { id: 2, status: 'Draft', ingestion: 'Scanned', published: false, availability: 'Public' },
  unpublished: {
    id: 3,
    status: 'Unpublished',
    ingestion: 'Scanned',
    published: true,
    availability: 'Public',
  },
  violation: {
    id: 4,
    status: 'UnpublishedViolation',
    ingestion: 'Scanned',
    published: true,
    availability: 'Public',
  },
  unscanned: {
    id: 5,
    status: 'Published',
    ingestion: 'Pending',
    published: true,
    availability: 'Public',
  },
  blocked: {
    id: 6,
    status: 'Published',
    ingestion: 'Blocked',
    published: true,
    availability: 'Public',
  },
  scheduled: {
    id: 7,
    status: 'Published',
    ingestion: 'Scanned',
    published: false,
    availability: 'Public',
  },
  private: {
    id: 8,
    status: 'Published',
    ingestion: 'Scanned',
    published: true,
    availability: 'Private',
  },
  unsearchable: {
    id: 9,
    status: 'Published',
    ingestion: 'Scanned',
    published: true,
    availability: 'Unsearchable',
  },
  earlyAccess: {
    id: 10,
    status: 'Published',
    ingestion: 'Scanned',
    published: true,
    availability: 'EarlyAccess',
  },
} as const;

const VIEWERS: Record<string, ArticleReader> = {
  anon: undefined,
  stranger: { id: 8 },
  owner: { id: OWNER },
  moderator: { id: 9, isModerator: true },
};

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'UnpublishedViolation', 'Processing');
    CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "AssociationType" AS ENUM ('Suggested');
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp(3), image text, "profilePictureId" int);
    CREATE TABLE "Article" (
      id int PRIMARY KEY, title text NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1, "userId" int NOT NULL,
      "publishedAt" timestamp(3), status "ArticleStatus" NOT NULL,
      ingestion "ArticleIngestionStatus" NOT NULL, availability "Availability" NOT NULL
    );
    CREATE TABLE "ModelAssociations" (
      id int PRIMARY KEY, "fromModelId" int NOT NULL, "toModelId" int, "toArticleId" int,
      "associatedById" int, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      type "AssociationType" NOT NULL, index int
    );
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner');
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    INSERT INTO "Model" VALUES (${MODEL}, ${OWNER}), (${OTHER_MODEL}, ${MODEL_OWNER});
  `);
  for (const [key, a] of Object.entries(ARTICLES)) {
    await h.pg.query(
      `INSERT INTO "Article" VALUES ($1, $2, 1, $3, $4, $5::"ArticleStatus", $6::"ArticleIngestionStatus", $7::"Availability")`,
      [
        a.id,
        key,
        OWNER,
        a.published ? new Date('2026-01-01') : null,
        a.status,
        a.ingestion,
        a.availability,
      ]
    );
    await h.pg.query(
      `INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", type, index) VALUES ($1, $2, $1, 'Suggested', $1)`,
      [a.id, MODEL]
    );
  }
  // dbWrite is the PGlite client for every call these services make.
  const { model, modelAssociations, $transaction } = dbMock.dbWrite;
  model.findUnique.mockImplementation(((args: never) => h.prisma.model.findUnique(args)) as never);
  modelAssociations.findMany.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.findMany(args)) as never);
  modelAssociations.deleteMany.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.deleteMany(args)) as never);
  modelAssociations.upsert.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.upsert(args)) as never);
  $transaction.mockImplementation(((ops: never) => h.prisma.$transaction(ops)) as never);
}, 60_000);

afterAll(() => h?.stop());

describe('getAssociatedResourcesSimple article side', () => {
  const listed = async (viewer: ArticleReader) =>
    (
      await getAssociatedResourcesSimple(
        { fromId: MODEL, type: 'Suggested', browsingLevel: 31 },
        viewer
      )
    ).map((x) => ('title' in x.item ? x.item.title : null));

  it('lists only live, viewable articles to anyone but the author and moderators', async () => {
    expect(await listed(VIEWERS.anon)).toEqual(['live', 'unsearchable', 'earlyAccess']);
    expect(await listed(VIEWERS.stranger)).toEqual(['live', 'unsearchable', 'earlyAccess']);
  });

  it('lists every one of their own articles to the author, and all to a moderator', async () => {
    const all = Object.keys(ARTICLES);
    expect(await listed(VIEWERS.owner)).toEqual(all);
    expect(await listed(VIEWERS.moderator)).toEqual(all);
  });

  it('does not return the read-rule columns on the article item', async () => {
    const [first] = await getAssociatedResourcesSimple({
      fromId: MODEL,
      type: 'Suggested',
      browsingLevel: 31,
    });
    expect(Object.keys(first.item).sort()).toEqual(['id', 'nsfwLevel', 'title', 'user']);
  });
});

describe('setAssociatedResources and articles the editor cannot list', () => {
  const ids = async () =>
    (
      await h.prisma.modelAssociations.findMany({
        where: { fromModelId: OTHER_MODEL },
        select: { toArticleId: true },
        orderBy: { id: 'asc' },
      })
    ).map((x) => x.toArticleId);

  it('keeps a link to an article the owner cannot read, and removes one they dropped', async () => {
    await h.pg.query(
      `INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", type, index)
       VALUES (201, $1, ${ARTICLES.live.id}, 'Suggested', 0), (202, $1, ${ARTICLES.draft.id}, 'Suggested', 1)`,
      [OTHER_MODEL]
    );
    await setAssociatedResources({ fromId: OTHER_MODEL, type: 'Suggested', associations: [] }, {
      id: MODEL_OWNER,
    } as SessionUser);
    expect(await ids()).toEqual([ARTICLES.draft.id]);
  });
});

describe('canReadArticle matches the article-by-id query filter', () => {
  // getArticleById's filter before it moved to articleReadableWhere. A drift in either fails here.
  const previousWhere = (v: ArticleReader): Prisma.ArticleWhereInput => ({
    OR: !v?.isModerator
      ? [
          { publishedAt: { not: null }, status: 'Published', ingestion: 'Scanned' },
          { userId: v?.id },
        ]
      : undefined,
  });

  it.each(Object.entries(VIEWERS))('for %s', async (_, viewer) => {
    const ids = async (where: Prisma.ArticleWhereInput) =>
      (
        await h.prisma.article.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })
      ).map((x) => x.id);
    expect(await ids(articleReadableWhere(viewer))).toEqual(await ids(previousWhere(viewer)));

    const rows = await h.prisma.article.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        userId: true,
        publishedAt: true,
        status: true,
        ingestion: true,
        availability: true,
      },
    });
    const inWhere = new Set(await ids(articleReadableWhere(viewer)));
    for (const row of rows)
      expect([row.id, canReadArticle(row, viewer)]).toEqual([
        row.id,
        inWhere.has(row.id) && canViewArticle(row, viewer),
      ]);
  });
});
