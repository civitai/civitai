import { PGlite } from '@electric-sql/pglite';
import type * as LegalHoldService from '~/server/services/legal-hold.service';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as TextModerationService from '~/server/services/text-moderation.service';
import type * as TextScanRoute from '~/server/services/text-scan/route';

// The Redis-backed post-commit helpers never settle without a live Redis, so they are stubbed.
const { deleteImageById } = vi.hoisted(() => ({ deleteImageById: vi.fn(async () => undefined) }));

vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LegalHoldService>()),
  holdMarkerViewExists: async () => true,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  deleteImageById,
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs: vi.fn(async ({ html }: { html: string }) => ({ evaluated: true, html, uses: [] })),
  getReferencedBlurbIds: vi.fn(async () => []),
  reconcileBlurbReferences: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanRoute>()),
  submitTextModerationOrScan: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

import {
  applyArticleContentChange,
  deleteArticleById,
  linkArticleContentImages,
  ownerUnderSafetyReport,
  unusedAuthorImage,
  upsertArticle,
} from '~/server/services/article.service';
import { Prisma } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { articlesSearchIndex } from '~/server/search-index';

const ARTICLE_ID = 21;
const AUTHOR = 7;
const SOMEONE_ELSE = 8;
const MODERATOR = 99;

/** `uses`: the other relations that show this image, by their Prisma relation name. */
type Row = {
  id: number;
  userId: number;
  postId: number | null;
  uses: string[];
  needsReview?: string | null;
  ingestion?: string;
  nsfwLevel?: number;
  blockedFor?: string | null;
};
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id,
  userId: AUTHOR,
  postId: null,
  uses: [],
  needsReview: null,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  blockedFor: null,
  ...over,
});

// Every image below was linked into the article and leaves it in the same edit.
const UNUSED_OWN = row(1);
const SOMEONE_ELSES = row(2, { userId: SOMEONE_ELSE });
const IN_A_POST = row(3, { postId: 500 });
const LINKED_ELSEWHERE = row(4, { uses: ['connections'] });
const ANOTHER_ARTICLES_COVER = row(5, { uses: ['article'] });
const A_CHALLENGE_COVER = row(6, { uses: ['challengesCover'] });
// Moderation decides these, so an article edit never deletes them.
const REPORTED = row(7, { uses: ['reports'] });
const AWAITING_REVIEW = row(8, { needsReview: 'minor' });
const BLOCKED = row(9, { ingestion: 'Blocked' });
const BLOCKED_LEVEL = row(10, { ingestion: 'Error', nsfwLevel: 32 });
const BLOCK_REASON = row(11, { ingestion: 'Error', blockedFor: 'tos' });
// A plain id column with no Prisma relation, so it is checked by its own query.
const AN_OFFERING_COVER = row(12);
const UNLINKED = [
  UNUSED_OWN,
  SOMEONE_ELSES,
  IN_A_POST,
  LINKED_ELSEWHERE,
  ANOTHER_ARTICLES_COVER,
  A_CHALLENGE_COVER,
  REPORTED,
  AWAITING_REVIEW,
  BLOCKED,
  BLOCKED_LEVEL,
  BLOCK_REASON,
  AN_OFFERING_COVER,
];

// Covers of the deleted article. They are not content links, so the article's connections omit them,
// and the article itself uses each one until its row is deleted.
const OWN_COVER = row(13, { uses: ['article'] });
const A_MODERATORS_COVER = row(14, { userId: MODERATOR, uses: ['article'] });
const COVER_IN_A_COLLECTION = row(15, { uses: ['article', 'collectionItems'] });
const COVERS = [OWN_COVER, A_MODERATORS_COVER, COVER_IN_A_COLLECTION];

/** Set when the article row is deleted, which frees its cover's `article` relation. */
let deletedArticleCover: number | null = null;
const deleteArticleWithCover = (cover: Row) =>
  dbMock.dbWrite.article.delete.mockImplementation((async () => {
    deletedArticleCover = cover.id;
    return { coverId: cover.id };
  }) as never);

const isUnusedCondition = (cond: unknown) =>
  JSON.stringify(cond) === JSON.stringify({ none: {} }) ||
  JSON.stringify(cond) === JSON.stringify({ is: null });

/** Applies the query's filters, so a dropped filter widens the result as it would in Prisma. */
const matches = (row: Row, where: Record<string, any>) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'id') return cond.in.includes(row.id);
    if (['userId', 'postId', 'needsReview', 'blockedFor'].includes(key))
      return row[key as keyof Row] === cond;
    if (key === 'ingestion' || key === 'nsfwLevel') return row[key] !== cond.not;
    // The content-url lookup: these tests save content with no images in it.
    if (key === 'url') return cond.in.length > 0;
    // `{ none: {} }` on a list relation, `{ is: null }` on a single one: the image is not used there.
    if (!isUnusedCondition(cond))
      throw new Error(`unexpected filter on ${key}: ${JSON.stringify(cond)}`);
    return !row.uses.includes(key) || (key === 'article' && row.id === deletedArticleCover);
  });

/** What the owner's legal-hold read returns: `[{ held }]`, no row, or `null` to make it fail. */
const hold = { rows: [{ held: false }] as { held: boolean }[] | null };

beforeEach(() => {
  vi.clearAllMocks();
  deletedArticleCover = null;
  hold.rows = [{ held: false }];
  dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
    if (!strings.join('?').includes(' AS held')) return undefined;
    if (!hold.rows) throw new Error('relation "EvidenceHeldUser" does not exist');
    return hold.rows;
  }) as never);
  // The article's own connections, after the edit: every unlinked image.
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue(
    UNLINKED.map((row) => ({ imageId: row.id })) as never
  );
  dbMock.dbWrite.image.findMany.mockImplementation((async ({ where }: any) =>
    [...UNLINKED, ...COVERS]
      .filter((row) => matches(row, where))
      .map((row) => ({ id: row.id }))) as never);
  const stored = {
    id: ARTICLE_ID,
    userId: AUTHOR,
    title: 'A title',
    content: '<p>had images</p>',
    coverId: null,
    status: 'Draft',
    scheduledAt: null,
    publishedAt: null,
    nsfwLevel: 1,
    userNsfwLevel: 1,
    lockedProperties: [],
    metadata: {},
  };
  dbMock.dbWrite.article.findUnique.mockResolvedValue(stored as never);
  dbMock.dbRead.article.findUnique.mockResolvedValue(stored as never);
  dbMock.dbWrite.article.update.mockResolvedValue(stored as never);
  dbMock.dbWrite.article.delete.mockResolvedValue({ coverId: null } as never);
  dbMock.dbWrite.csamReport.count.mockResolvedValue(0 as never);
  dbMock.dbWrite.serviceOffering.findMany.mockImplementation((async ({ where }: any) =>
    where.coverImageId.in.includes(AN_OFFERING_COVER.id)
      ? [{ coverImageId: AN_OFFERING_COVER.id }]
      : []) as never);
});

describe('linkArticleContentImages', () => {
  it("returns as orphans only the author's own images that nothing else uses", async () => {
    const { orphanedImageIds } = await linkArticleContentImages({
      articleId: ARTICLE_ID,
      content: '',
      userId: AUTHOR,
      ownerId: AUTHOR,
      cleanupOnly: true,
    });

    expect(orphanedImageIds).toEqual([UNUSED_OWN.id]);
  });
});

describe('applyArticleContentChange', () => {
  const save = (userId: number) =>
    applyArticleContentChange({
      id: ARTICLE_ID,
      userId,
      content: '<p>no images left</p>',
      scanContent: false,
      context: {
        ownerId: AUTHOR,
        title: 'A title',
        previousContent: '<p>had images</p>',
        coverId: null,
        publication: { status: 'Draft' as never, scheduledAt: null },
      },
    });

  it("deletes only the author's own unused image when the author removes the links", async () => {
    await save(AUTHOR);

    expect(deletedIds()).toEqual([UNUSED_OWN.id]);
  });

  it("deletes the author's unused image, not the editor's, when a moderator edits", async () => {
    await save(MODERATOR);

    expect(deletedIds()).toEqual([UNUSED_OWN.id]);
  });
});

const deletedIds = () => deleteImageById.mock.calls.map(([arg]: any) => arg.id);

describe('upsertArticle', () => {
  it("deletes the author's unused image when a moderator saves the edit", async () => {
    await upsertArticle({
      id: ARTICLE_ID,
      userId: MODERATOR,
      isModerator: true,
      title: 'A title',
      content: '<p>no images left</p>',
      status: 'Draft',
    } as never);

    expect(deletedIds()).toEqual([UNUSED_OWN.id]);
  });
});

describe('deleteArticleById', () => {
  it.each([
    ['the author', AUTHOR, false],
    ['a moderator', MODERATOR, true],
  ])(
    "deletes only the author's own unused images when %s deletes the article",
    async (_, userId, isModerator) => {
      await deleteArticleById({ id: ARTICLE_ID, userId, isModerator });

      expect(deletedIds()).toEqual([UNUSED_OWN.id]);
    }
  );

  // An article saved before shop keys were refused can hold one as the author's own image row.
  it('keeps an unused image of the author whose key shop artwork uses', async () => {
    const shopKey = '0a0b0c0d-0000-4000-8000-0000000000aa';
    dbMock.dbWrite.image.findMany.mockImplementation((async ({ where }: any) =>
      [...UNLINKED, ...COVERS]
        .filter((row) => matches(row, where))
        .map((row) => ({
          id: row.id,
          url: row.id === UNUSED_OWN.id ? shopKey : `key-${row.id}`,
        }))) as never);
    const heldRead = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      strings.join('').includes('unnest(')
        ? Promise.resolve([{ key: shopKey }])
        : heldRead?.(strings, ...values)) as never);

    await deleteArticleById({ id: ARTICLE_ID, userId: AUTHOR });

    expect(deletedIds()).toEqual([]);
  });

  const deleteWithCover = async (cover: Row) => {
    deleteArticleWithCover(cover);
    await deleteArticleById({ id: ARTICLE_ID, userId: AUTHOR });
  };

  it("deletes the author's own unused cover", async () => {
    await deleteWithCover(OWN_COVER);

    expect(deletedIds().sort((a, b) => a - b)).toEqual([UNUSED_OWN.id, OWN_COVER.id]);
  });

  it.each([
    ['a moderator uploaded', A_MODERATORS_COVER],
    ['is still in a collection', COVER_IN_A_COLLECTION],
    ['is a service offering cover', AN_OFFERING_COVER],
  ])('keeps a cover that %s', async (_, cover) => {
    await deleteWithCover(cover);

    expect(deletedIds()).toEqual([UNUSED_OWN.id]);
  });

  it('reports the delete and drops it from the index when the cleanup fails', async () => {
    const queueUpdate = vi
      .spyOn(articlesSearchIndex, 'queueUpdate')
      .mockResolvedValue(undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dbMock.dbWrite.csamReport.count.mockRejectedValue(new Error('db down'));
    deleteArticleWithCover(OWN_COVER);

    await expect(deleteArticleById({ id: ARTICLE_ID, userId: AUTHOR })).resolves.toEqual({
      coverId: OWN_COVER.id,
    });
    expect(queueUpdate).toHaveBeenCalledWith([
      { id: ARTICLE_ID, action: SearchIndexUpdateQueueAction.Delete },
    ]);
    expect(deletedIds()).toEqual([]);
  });
});

/**
 * Relations of `Image` that are part of the image itself, not a place it is shown: they go when
 * the image goes, so they cannot make it "in use".
 */
const PART_OF_THE_IMAGE: Record<string, string> = {
  user: 'the owner, checked by userId',
  post: 'checked by postId',
  reactions: 'reactions to this image',
  thread: 'comments on this image',
  tags: 'its tags',
  tagVotes: 'votes on its tags',
  tagComposites: 'its tag view',
  modHelper: 'moderation scratch data',
  resources: 'resources detected in it',
  resourceHelper: 'its resource view',
  engagements: 'engagement with this image',
  tools: 'tools it records',
  techniques: 'techniques it records',
  flags: 'its scan flags',
  ratingRequests: 'rating requests for it',
  tagsNew: 'its tags',
  imageResourceNew: 'resources detected in it',
  imageTagsForReview: 'tags queued for review on it',
  caption: 'its storyline caption',
};

describe('unusedAuthorImage', () => {
  it('names every Image relation, as a place the image is used or as part of the image', () => {
    const image = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Image');
    const relations = image?.fields.filter((f) => f.kind === 'object').map((f) => f.name) ?? [];
    const checked = Object.keys(unusedAuthorImage(AUTHOR));

    // A new relation that shows an image elsewhere belongs in the predicate, or the cleanup
    // deletes an image that relation still shows.
    expect(relations.filter((r) => !checked.includes(r) && !(r in PART_OF_THE_IMAGE))).toEqual([]);
    // And each one asks that the image is NOT used there.
    const where = unusedAuthorImage(AUTHOR) as Record<string, unknown>;
    expect(relations.filter((r) => r in where && !isUnusedCondition(where[r]))).toEqual([]);
    expect(relations.length).toBeGreaterThan(Object.keys(PART_OF_THE_IMAGE).length);
  });
});

describe('an owner with a safety report on file', () => {
  beforeEach(() => {
    dbMock.dbWrite.csamReport.count.mockImplementation((async ({ where }: any) =>
      where.userId === AUTHOR ? 1 : 0) as never);
  });

  it('keeps every image the edit unlinks', async () => {
    const { orphanedImageIds } = await linkArticleContentImages({
      articleId: ARTICLE_ID,
      content: '',
      userId: AUTHOR,
      ownerId: AUTHOR,
      cleanupOnly: true,
    });

    expect(orphanedImageIds).toEqual([]);
  });

  it.each([
    ['the author', AUTHOR, false],
    ['a moderator', MODERATOR, true],
  ])(
    'keeps the cover and every content image when %s deletes the article',
    async (_, userId, isModerator) => {
      deleteArticleWithCover(OWN_COVER);
      await deleteArticleById({ id: ARTICLE_ID, userId, isModerator });

      expect(deletedIds()).toEqual([]);
    }
  );
});

// A hold marker, an image awaiting review, or a report naming them as a secondary user: no
// "CsamReport" row of their own, so only the shared hold read can see it.
describe.each([
  ['under a legal hold with no report of their own', [{ held: true }]],
  ['whose legal hold read returns no row', []],
  ['whose legal hold read fails', null],
])('an owner %s', (_, rows) => {
  beforeEach(() => {
    hold.rows = rows;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('keeps every image the edit unlinks', async () => {
    const { orphanedImageIds } = await linkArticleContentImages({
      articleId: ARTICLE_ID,
      content: '',
      userId: AUTHOR,
      ownerId: AUTHOR,
      cleanupOnly: true,
    });

    expect(orphanedImageIds).toEqual([]);
  });

  it('keeps the cover and every content image when the article is deleted', async () => {
    deleteArticleWithCover(OWN_COVER);
    await deleteArticleById({ id: ARTICLE_ID, userId: AUTHOR });

    expect(deletedIds()).toEqual([]);
  });
});

// The read itself, against the real hold migration on a Postgres stand-in.
describe('ownerUnderSafetyReport over the real hold view', () => {
  const MARKED = 71; // a hold marker
  const SECONDARY = 72; // the secondary user on someone else's pending report
  const REVIEWED = 73; // an image awaiting CSAM review
  const FREE = 74;
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE "Image" (
        id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "needsReview" text,
        "blockedFor" text, metadata jsonb
      );
      CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "CsamReport" (
        id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
        images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
      );
    `);
    await db.exec(
      readFileSync(
        path.resolve(
          __dirname,
          '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
        ),
        'utf8'
      )
    );
    await db.exec(`
      INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKED}, 'manual', 'review');
      INSERT INTO "CsamReport" ("userId", details) VALUES (1, '{"secondaryUserId": ${SECONDARY}}');
      INSERT INTO "Image" (id, "userId", "needsReview") VALUES (9001, ${REVIEWED}, 'csam');
    `);
  });
  afterAll(() => db.close());

  // None of them has a "CsamReport" row of their own, so the count alone would let each through.
  const heldOn = (ownerId: number) =>
    ownerUnderSafetyReport(
      {
        csamReport: { count: async () => 0 },
        $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const flat = Prisma.sql(strings, ...(values as never[]));
          return (await db.query(flat.text, flat.values as unknown[])).rows;
        }) as never,
      } as never,
      ownerId
    );

  it.each([
    ['being the placeholder owner', -1],
    ['a hold marker', MARKED],
    ["the secondary user on another's report", SECONDARY],
    ['an image awaiting CSAM review', REVIEWED],
  ])('holds an owner held by %s', async (_, ownerId) => {
    expect(await heldOn(ownerId)).toBe(true);
  });

  it('lets an owner with no hold through', async () => {
    expect(await heldOn(FREE)).toBe(false);
  });
});
