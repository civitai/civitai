import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as TextModerationService from '~/server/services/text-moderation.service';
import type * as TextScanRoute from '~/server/services/text-scan/route';

// The Redis-backed post-commit helpers never settle without a live Redis, so they are stubbed.
const { deleteImageById } = vi.hoisted(() => ({ deleteImageById: vi.fn(async () => undefined) }));

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
  upsertArticle,
} from '~/server/services/article.service';

const ARTICLE_ID = 21;
const AUTHOR = 7;
const SOMEONE_ELSE = 8;
const MODERATOR = 99;

/** `uses`: the other relations that show this image, by their Prisma relation name. */
type Row = { id: number; userId: number; postId: number | null; uses: string[] };

// Every image below was linked into the article and leaves it in the same edit.
const UNUSED_OWN: Row = { id: 1, userId: AUTHOR, postId: null, uses: [] };
const SOMEONE_ELSES: Row = { id: 2, userId: SOMEONE_ELSE, postId: null, uses: [] };
const IN_A_POST: Row = { id: 3, userId: AUTHOR, postId: 500, uses: [] };
const LINKED_ELSEWHERE: Row = { id: 4, userId: AUTHOR, postId: null, uses: ['connections'] };
const ANOTHER_ARTICLES_COVER: Row = { id: 5, userId: AUTHOR, postId: null, uses: ['article'] };
const A_CHALLENGE_COVER: Row = { id: 6, userId: AUTHOR, postId: null, uses: ['challengesCover'] };
const UNLINKED = [
  UNUSED_OWN,
  SOMEONE_ELSES,
  IN_A_POST,
  LINKED_ELSEWHERE,
  ANOTHER_ARTICLES_COVER,
  A_CHALLENGE_COVER,
];

/** Applies the query's filters, so a dropped filter widens the result as it would in Prisma. */
const matches = (row: Row, where: Record<string, any>) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'id') return cond.in.includes(row.id);
    if (key === 'userId' || key === 'postId') return row[key] === cond;
    // `{ none: {} }` on a list relation, `{ is: null }` on a single one: the image is not used there.
    return !row.uses.includes(key);
  });

beforeEach(() => {
  vi.clearAllMocks();
  // The article's own connections, after the edit: the four unlinked images, then nothing else.
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue(
    UNLINKED.map((row) => ({ imageId: row.id })) as never
  );
  dbMock.dbWrite.image.findMany.mockImplementation((async ({ where }: any) =>
    UNLINKED.filter((row) => matches(row, where)).map((row) => ({ id: row.id }))) as never);
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
});
