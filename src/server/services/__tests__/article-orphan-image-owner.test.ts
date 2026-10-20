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
  linkArticleContentImages,
} from '~/server/services/article.service';

const ARTICLE_ID = 21;
const AUTHOR = 7;
const SOMEONE_ELSE = 8;
const MODERATOR = 99;

type Row = { id: number; userId: number; postId: number | null; otherConnections: number };

// Every image below was linked into the article and has just been removed from its content.
const UNUSED_OWN: Row = { id: 1, userId: AUTHOR, postId: null, otherConnections: 0 };
const SOMEONE_ELSES: Row = { id: 2, userId: SOMEONE_ELSE, postId: null, otherConnections: 0 };
const IN_A_POST: Row = { id: 3, userId: AUTHOR, postId: 500, otherConnections: 0 };
const LINKED_ELSEWHERE: Row = { id: 4, userId: AUTHOR, postId: null, otherConnections: 1 };
const UNLINKED = [UNUSED_OWN, SOMEONE_ELSES, IN_A_POST, LINKED_ELSEWHERE];

/** Applies the filters the orphan query uses, so a dropped filter widens the result as in Prisma. */
const matches = (row: Row, where: Record<string, any>) =>
  (!where.id?.in || where.id.in.includes(row.id)) &&
  (where.userId === undefined || row.userId === where.userId) &&
  (where.postId === undefined || row.postId === where.postId) &&
  (where.connections?.none === undefined || row.otherConnections === 0);

beforeEach(() => {
  vi.clearAllMocks();
  // The article's own connections, after the edit: the four unlinked images, then nothing else.
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue(
    UNLINKED.map((row) => ({ imageId: row.id })) as never
  );
  dbMock.dbWrite.image.findMany.mockImplementation((async ({ where, select }: any) =>
    UNLINKED.filter((row) => matches(row, where)).map((row) =>
      select?.userId ? row : { id: row.id }
    )) as never);
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

    expect(deleteImageById.mock.calls.map(([arg]: any) => arg.id)).toEqual([UNUSED_OWN.id]);
  });

  it("deletes the author's unused image, not the editor's, when a moderator edits", async () => {
    await save(MODERATOR);

    expect(deleteImageById.mock.calls.map(([arg]: any) => arg.id)).toEqual([UNUSED_OWN.id]);
  });
});
