import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  articleReadableWhere,
  articleReadSelect,
  canReadArticle,
  canViewArticle,
  type ArticleReader,
} from '~/server/services/article-read';
import {
  getAssociatedResourcesSimple,
  setAssociatedResources,
} from '~/server/services/model.service';
import { BlockedByUsers } from '~/server/services/user-preferences.service';
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

// Live, public articles by OWNER, one per browsing-level case, linked from LEVEL_MODEL.
const LEVEL_MODEL = 300;
const LEVEL_ARTICLES = { pg: [21, 1], r: [22, 4], x: [23, 8], unrated: [24, 0] } as const;
const PG = 1;
const MATURE = 31;

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
    CREATE SEQUENCE assoc_id START 1000;
    CREATE TABLE "ModelAssociations" (
      id int PRIMARY KEY DEFAULT nextval('assoc_id'), "fromModelId" int NOT NULL, "toModelId" int, "toArticleId" int,
      "associatedById" int, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      type "AssociationType" NOT NULL, index int
    );
    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner');
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Image" (id int PRIMARY KEY, "nsfwLevel" int NOT NULL);
    CREATE TABLE "ImageConnection" (
      "imageId" int NOT NULL, "entityId" int NOT NULL, "entityType" text NOT NULL,
      PRIMARY KEY ("imageId", "entityType", "entityId")
    );
    INSERT INTO "Model" VALUES (${MODEL}, ${OWNER}), (${OTHER_MODEL}, ${MODEL_OWNER}), (${LEVEL_MODEL}, ${MODEL_OWNER});
  `);
  for (const [key, [id, nsfwLevel]] of Object.entries(LEVEL_ARTICLES)) {
    await h.pg.query(
      `INSERT INTO "Article" VALUES ($1, $2, $3, $4, '2026-01-01', 'Published', 'Scanned', 'Public')`,
      [id, key, nsfwLevel, OWNER]
    );
    await h.pg.query(
      `INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", type, index) VALUES ($1, $2, $1, 'Suggested', $1)`,
      [id, LEVEL_MODEL]
    );
  }
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
  dbMock.dbRead.imageConnection.findMany.mockImplementation(((args: never) =>
    h.prisma.imageConnection.findMany(args)) as never);
}, 60_000);

afterAll(() => h?.stop());

const list = (
  viewer: ArticleReader,
  { fromId = MODEL, restricted = false, browsingLevel = 31 } = {}
) =>
  getAssociatedResourcesSimple(
    { fromId, type: 'Suggested', browsingLevel },
    {
      isRestricted: () => restricted,
      viewer: viewer ?? {},
    }
  );
const save = (
  fromId: number,
  user: SessionUser,
  associations: Parameters<typeof setAssociatedResources>[0]['associations'] = [],
  { restricted = false, browsingLevel = 31 } = {}
) =>
  setAssociatedResources({ fromId, type: 'Suggested', associations, browsingLevel }, user, {
    isRestricted: () => restricted,
    viewer: user,
  });
const listed = async (viewer: ArticleReader) =>
  (await list(viewer)).items.map((x) => ('title' in x.item ? x.item.title : null));

describe('getAssociatedResourcesSimple article side', () => {
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
    const [first] = (await list(undefined)).items;
    expect(Object.keys(first.item).sort()).toEqual(['id', 'nsfwLevel', 'title', 'user']);
  });
});

// Linked articles follow the article listing's browsing-level rule (articleWithinBrowsingLevel).
describe('getAssociatedResourcesSimple article browsing level', () => {
  const listed = async (viewer: ArticleReader, browsingLevel: number) =>
    (
      await getAssociatedResourcesSimple(
        { fromId: LEVEL_MODEL, type: 'Suggested', browsingLevel },
        viewer
      )
    ).map((x) => ('title' in x.item ? x.item.title : null));

  it('hides R and X articles at PG from anyone, and unrated ones from all but author and mods', async () => {
    expect(await listed(VIEWERS.anon, PG)).toEqual(['pg']);
    expect(await listed(VIEWERS.stranger, PG)).toEqual(['pg']);
    expect(await listed(VIEWERS.owner, PG)).toEqual(['pg', 'unrated']);
    expect(await listed(VIEWERS.moderator, PG)).toEqual(['pg', 'unrated']);
  });

  it('shows R and X articles at a mature level, still keeping unrated ones to author and mods', async () => {
    expect(await listed(VIEWERS.anon, MATURE)).toEqual(['pg', 'r', 'x']);
    expect(await listed(VIEWERS.stranger, MATURE)).toEqual(['pg', 'r', 'x']);
    expect(await listed(VIEWERS.owner, MATURE)).toEqual(['pg', 'r', 'x', 'unrated']);
    expect(await listed(VIEWERS.moderator, MATURE)).toEqual(['pg', 'r', 'x', 'unrated']);
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
    await save(OTHER_MODEL, { id: MODEL_OWNER } as SessionUser);
    expect(await ids()).toEqual([ARTICLES.draft.id]);
  });

  // Drops every link: deletes LEVEL_MODEL's rows, so the browsing-level reads above must run before
  // these, and the two calls in the first test run in order. OWNER wrote the articles.
  const savedLevelLinks = async (fromId: number, editor: number, browsingLevel: number) => {
    await setAssociatedResources({ fromId, type: 'Suggested', associations: [], browsingLevel }, {
      id: editor,
    } as SessionUser);
    const rows = await h.prisma.modelAssociations.findMany({
      where: { fromModelId: fromId },
      select: { toArticleId: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((x) => x.toArticleId);
  };

  it('keeps links the editor could not see at its level, and removes the ones it showed', async () => {
    const { r, x, unrated } = LEVEL_ARTICLES;
    expect(await savedLevelLinks(LEVEL_MODEL, MODEL_OWNER, PG)).toEqual([r[0], x[0], unrated[0]]);
    expect(await savedLevelLinks(LEVEL_MODEL, MODEL_OWNER, MATURE)).toEqual([unrated[0]]);
  });

  it("removes the author's own unrated link, which their editor showed", async () => {
    await h.pg.query(
      `INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", type, index)
       VALUES (401, ${MODEL}, ${LEVEL_ARTICLES.unrated[0]}, 'Suggested', 0)`
    );
    expect(await savedLevelLinks(MODEL, OWNER, PG)).not.toContain(LEVEL_ARTICLES.unrated[0]);
  });
});

describe('setAssociatedResources only writes rows of the model being edited', () => {
  const A = 300;
  const A_OWNER = 30;
  const B = 400;
  const B_ROW = 401;

  beforeAll(async () => {
    await h.pg.exec(`
      INSERT INTO "Model" VALUES (${A}, ${A_OWNER}), (${B}, 40);
      INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", "associatedById", type, index)
      VALUES (${B_ROW}, ${B}, ${ARTICLES.unsearchable.id}, 40, 'Suggested', 5);
    `);
  });

  it("leaves another model's association untouched when its id is in the payload", async () => {
    const before = await h.prisma.modelAssociations.findUniqueOrThrow({ where: { id: B_ROW } });

    await save(A, { id: A_OWNER } as SessionUser, [
      { id: B_ROW, resourceId: ARTICLES.live.id, resourceType: 'article' },
    ]);

    expect(await h.prisma.modelAssociations.findUniqueOrThrow({ where: { id: B_ROW } })).toEqual(
      before
    );
    const aRows = await h.prisma.modelAssociations.findMany({
      where: { fromModelId: A },
      select: { toArticleId: true, associatedById: true, index: true },
    });
    expect(aRows).toEqual([{ toArticleId: ARTICLES.live.id, associatedById: A_OWNER, index: 0 }]);
  });
});

describe("a moderator editing another user's model", () => {
  const M = 450;
  const moderator = { id: 9, isModerator: true } as SessionUser;
  const add = [{ resourceId: ARTICLES.live.id, resourceType: 'article' as const }];
  const saveAs = (viewer: { id?: number; isModerator?: boolean }) =>
    setAssociatedResources(
      { fromId: M, type: 'Suggested', associations: add, browsingLevel: 31 },
      moderator,
      {
        isRestricted: () => false,
        viewer,
      }
    );
  const rows = () => h.prisma.modelAssociations.count({ where: { fromModelId: M } });

  beforeAll(() => h.pg.exec(`INSERT INTO "Model" VALUES (${M}, 45);`));

  it('is refused when the reader does not count them as a moderator', async () => {
    await expect(saveAs({ id: 9, isModerator: false })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(await rows()).toBe(0);
  });

  it('is allowed when the reader counts them as a moderator', async () => {
    await saveAs({ id: 9, isModerator: true });
    expect(await rows()).toBe(1);
  });
});

describe('associated articles whose author blocked the viewer', () => {
  const BLOCKED_VIEWER = VIEWERS.stranger!.id!;
  const VIEWERS_MODEL = 500;
  const VIEWERS_ROW = 501;

  beforeAll(async () => {
    await h.pg.exec(`
      INSERT INTO "Model" VALUES (${VIEWERS_MODEL}, ${BLOCKED_VIEWER});
      INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", type, index)
      VALUES (${VIEWERS_ROW}, ${VIEWERS_MODEL}, ${ARTICLES.live.id}, 'Suggested', 0);
    `);
  });

  // Every article here is OWNER's. OWNER, and a user with no article here, blocked the stranger.
  let blockedBy: MockInstance;
  beforeEach(() => {
    blockedBy = vi.spyOn(BlockedByUsers, 'getCached').mockImplementation((async ({
      userId,
    }: {
      userId: number;
    }) =>
      userId === BLOCKED_VIEWER
        ? [
            { id: 999, username: 'other' },
            { id: OWNER, username: 'owner' },
          ]
        : []) as never);
  });
  afterEach(() => blockedBy.mockRestore());

  it('are not listed to that viewer', async () => {
    expect(await listed(VIEWERS.stranger)).toEqual([]);
  });

  it('are still listed to everyone else, and all to a moderator', async () => {
    expect(await listed(VIEWERS.anon)).toEqual(['live', 'unsearchable', 'earlyAccess']);
    expect(await listed({ id: 99 })).toEqual(['live', 'unsearchable', 'earlyAccess']);
    expect(await listed({ id: BLOCKED_VIEWER, isModerator: true })).toEqual(Object.keys(ARTICLES));
  });

  it("are kept when that viewer saves their own model's list without them", async () => {
    await save(VIEWERS_MODEL, { id: BLOCKED_VIEWER } as SessionUser);
    expect(
      await h.prisma.modelAssociations.findUnique({ where: { id: VIEWERS_ROW } })
    ).not.toBeNull();
  });
});

describe('associated articles above SFW in a restricted region', () => {
  const REGION_MODEL = 600;
  const REGION_MODEL_OWNER = 60;
  // [id, title, own level, body image levels]
  const REGION_ARTICLES: [number, string, number, number[]][] = [
    [11, 'mature', 4, []],
    [12, 'matureBody', 1, [4]],
    [13, 'sfw', 1, [2]],
    [14, 'unrated', 0, []],
  ];

  beforeAll(async () => {
    await h.pg.exec(`INSERT INTO "Model" VALUES (${REGION_MODEL}, ${REGION_MODEL_OWNER});`);
    for (const [id, title, level, images] of REGION_ARTICLES) {
      await h.pg.query(
        `INSERT INTO "Article" VALUES ($1, $2, $3, ${OWNER}, '2026-01-01', 'Published', 'Scanned', 'Public')`,
        [id, title, level]
      );
      await h.pg.query(
        `INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", type, index) VALUES ($1, ${REGION_MODEL}, $2, 'Suggested', $2)`,
        [600 + id, id]
      );
      for (const [i, imageLevel] of images.entries()) {
        const imageId = id * 10 + i;
        await h.pg.query(`INSERT INTO "Image" VALUES ($1, $2)`, [imageId, imageLevel]);
        await h.pg.query(`INSERT INTO "ImageConnection" VALUES ($1, $2, 'Article')`, [imageId, id]);
      }
    }
  });

  it('withholds each one from a reader in a restricted region', async () => {
    const result = await list(VIEWERS.stranger, { fromId: REGION_MODEL, restricted: true });
    expect(result.items.map((x) => ('title' in x.item ? x.item.title : null))).toEqual(['sfw']);
    expect(result.regionDependent).toBe(true);
  });

  it('lists them outside a restricted region, but marks the answer region-dependent', async () => {
    const result = await list(undefined, { fromId: REGION_MODEL });
    // The unrated one fails the browsing-level rule first.
    expect(result.items.map((x) => ('title' in x.item ? x.item.title : null))).toEqual([
      'mature',
      'matureBody',
      'sfw',
    ]);
    expect(result.regionDependent).toBe(true);
  });

  it('lists them to their author and a moderator in a restricted region', async () => {
    for (const viewer of [VIEWERS.owner, VIEWERS.moderator]) {
      const result = await list(viewer, { fromId: REGION_MODEL, restricted: true });
      expect(result.items).toHaveLength(REGION_ARTICLES.length);
    }
  });

  it('does not mark a list with no such article region-dependent', async () => {
    expect((await list(undefined)).regionDependent).toBe(false);
  });

  it('are kept when the model owner saves the list from a restricted region', async () => {
    await save(REGION_MODEL, { id: REGION_MODEL_OWNER } as SessionUser, [], { restricted: true });
    const kept = await h.prisma.modelAssociations.findMany({
      where: { fromModelId: REGION_MODEL },
      select: { toArticleId: true },
      orderBy: { toArticleId: 'asc' },
    });
    expect(kept.map((x) => x.toArticleId)).toEqual([11, 12, 14]);
  });
});

describe('associated articles above the browsing level', () => {
  const LEVEL_MODEL = 800;
  const LEVEL_MODEL_OWNER = 80;
  const MATURE = 21;
  const { PG, X } = NsfwLevel;

  beforeAll(async () => {
    await h.pg.exec(`
      INSERT INTO "Model" VALUES (${LEVEL_MODEL}, ${LEVEL_MODEL_OWNER});
      INSERT INTO "Article" VALUES (${MATURE}, 'mature', ${X}, ${OWNER}, '2026-01-01', 'Published', 'Scanned', 'Public');
      INSERT INTO "ModelAssociations" (id, "fromModelId", "toArticleId", type, index)
      VALUES (821, ${LEVEL_MODEL}, ${MATURE}, 'Suggested', 0);
    `);
  });

  const count = async (viewer: ArticleReader, browsingLevel: number) =>
    (await list(viewer, { fromId: LEVEL_MODEL, browsingLevel })).items.length;

  it('are not listed to a reader browsing below them', async () => {
    expect(await count(undefined, PG)).toBe(0);
    expect(await count(VIEWERS.stranger, PG)).toBe(0);
  });

  it('are listed to a reader whose level includes them, and to the author and a moderator', async () => {
    expect(await count(undefined, PG | X)).toBe(1);
    expect(await count(VIEWERS.owner, PG)).toBe(1);
    expect(await count(VIEWERS.moderator, PG)).toBe(1);
  });

  it('are kept when the model owner saves the list browsing below them', async () => {
    await save(LEVEL_MODEL, { id: LEVEL_MODEL_OWNER } as SessionUser, [], { browsingLevel: PG });
    expect(await h.prisma.modelAssociations.findUnique({ where: { id: 821 } })).not.toBeNull();
  });
});

describe('the article read rule for each viewer', () => {
  const { live, draft, private: priv, unsearchable, earlyAccess } = ARTICLES;
  const ALL = Object.values(ARTICLES).map((a) => a.id);
  // Live rows only: the query half admits a Private one, and canViewArticle then drops it.
  const READABLE: Record<string, { where: number[]; read: number[] }> = {
    anon: {
      where: [live.id, priv.id, unsearchable.id, earlyAccess.id],
      read: [live.id, unsearchable.id, earlyAccess.id],
    },
    stranger: {
      where: [live.id, priv.id, unsearchable.id, earlyAccess.id],
      read: [live.id, unsearchable.id, earlyAccess.id],
    },
    owner: { where: ALL, read: ALL },
    moderator: { where: ALL, read: ALL },
  };

  const ids = async (where: Prisma.ArticleWhereInput) =>
    (
      await h.prisma.article.findMany({
        where: { AND: [where, { id: { in: ALL } }] },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((x) => x.id);

  it.each(Object.entries(VIEWERS))('for %s', async (name, viewer) => {
    expect(await ids(articleReadableWhere(viewer))).toEqual(READABLE[name].where);

    const rows = await h.prisma.article.findMany({
      where: { id: { in: ALL } },
      orderBy: { id: 'asc' },
      select: { id: true, ...articleReadSelect },
    });
    expect(rows.filter((r) => canReadArticle(r, viewer)).map((r) => r.id)).toEqual(
      READABLE[name].read
    );
    expect(rows.filter((r) => canViewArticle(r, viewer)).map((r) => r.id)).toEqual(
      name === 'anon' || name === 'stranger' ? ALL.filter((id) => id !== priv.id) : ALL
    );
  });

  // getArticleById's filter before this change put `{ userId: undefined }` in the OR for a
  // signed-out viewer. Prisma drops an undefined field from that branch rather than matching
  // every row, so a signed-out viewer never got a draft from it.
  it('the previous signed-out filter shape does not return a draft', async () => {
    const previous = (userId: number | undefined): Prisma.ArticleWhereInput => ({
      id: draft.id,
      OR: [{ publishedAt: { not: null }, status: 'Published', ingestion: 'Scanned' }, { userId }],
    });
    expect(await ids(previous(OWNER))).toEqual([draft.id]);
    expect(await ids(previous(undefined))).toEqual([]);
    expect(await ids({ id: draft.id, ...articleReadableWhere(undefined) })).toEqual([]);
  });
});
