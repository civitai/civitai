import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

/**
 * A moderator without the `csamReports` grant may not loosen an image `moderatorWithheldSql`
 * withholds from them: each writer below refuses it with FORBIDDEN before it writes, and still
 * writes a clean image, or the same image for a moderator with the grant. The rule runs for real on
 * PGlite; the Prisma reads and writes around it are the shared db mock. The refusals to a
 * non-moderator, the AI review's skip and the tag downvote are civitai/civitai#10583.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});

const WITHHELD = 101; // queued
const SIBLING = 102; // withheld from a moderator without the grant
const CLEAN = 103;
const OWNER = 7;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(CSAM_LINK_TABLES_SQL);
  await holder.db.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, type "MediaType" NOT NULL DEFAULT 'image',
      "mimeType" text, ingestion text NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "blockedFor" text, minor boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL DEFAULT 4,
      "userId" int NOT NULL, "acceptableMinor" boolean NOT NULL DEFAULT false, "pHash" bigint,
      "postId" int
    );
    ${WITHHELD_TABLES_SQL}
    INSERT INTO "Image" (id, url, "needsReview", "userId") VALUES (${WITHHELD}, 'key-a', 'csam', ${OWNER});
    INSERT INTO "Image" (id, url, "userId") VALUES (${SIBLING}, 'key-b', ${OWNER});
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES (104, 'key-b', 'Blocked', 'CSAM', 8);
    INSERT INTO "Image" (id, url, "userId") VALUES (${CLEAN}, 'key-c', ${OWNER});
  `);
});

beforeEach(() => {
  vi.clearAllMocks();
});

const { assertMayLoosenImages, withheldImageIds } = await import(
  '~/server/services/moderator-withheld.service'
);
const {
  setImagesNsfwLevel,
  updateImageNsfwLevel,
  toggleImageFlag,
  updateImageAcceptableMinor,
  resolveIngestionError,
} = await import('~/server/services/image.service');
const { rescanImageById } = await import('~/server/services/image-rescan.service');
const { rescanChallenge, playgroundReviewImage } = await import(
  '~/server/services/challenge.service'
);
const { rescanArticleImage } = await import('~/server/services/article.service');
const { addTagVotes, disableTags } = await import('~/server/services/tag.service');
const { updateCollectionItemsStatus } = await import('~/server/services/collection.service');

const forbidden = (p: Promise<unknown>) =>
  expect(p).rejects.toSatisfy((e) => e instanceof TRPCError && e.code === 'FORBIDDEN');
/** Runs `p` to wherever it ends and returns the error, so a control can say it was not the gate. */
const settle = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  );
const notForbidden = async (p: Promise<unknown>) => {
  const e = await settle(p);
  expect(e instanceof TRPCError && e.code === 'FORBIDDEN').toBe(false);
};

describe('withheldImageIds', () => {
  it('names both withheld images, not the clean one', async () => {
    const ids = await withheldImageIds([WITHHELD, SIBLING, CLEAN], { csamReview: false });
    expect([...ids].sort()).toEqual([WITHHELD, SIBLING]);
  });

  it('withholds nothing from a moderator with the grant', async () => {
    const ids = await withheldImageIds([WITHHELD, SIBLING], { csamReview: true });
    expect(ids.size).toBe(0);
  });

  it('refuses all or nothing, naming the withheld ids', async () => {
    await expect(assertMayLoosenImages([CLEAN, WITHHELD], { csamReview: false })).rejects.toThrow(
      `Nothing was changed: ${WITHHELD}.`
    );
  });
});

describe('updateImageNsfwLevel', () => {
  const current = (id: number) =>
    dbMock.dbWrite.image.findUnique.mockResolvedValue({
      id,
      metadata: {},
      postId: null,
      nsfwLevel: 8,
    } as never);
  const set = (id: number, nsfwLevel: number, csamReview = false) =>
    updateImageNsfwLevel({ id, nsfwLevel, userId: 1, isModerator: true, csamReview });

  it('refuses lowering a withheld image', async () => {
    current(WITHHELD);
    await forbidden(set(WITHHELD, 1));
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('lowers it for a moderator with the grant, and a clean image for any moderator', async () => {
    current(WITHHELD);
    await settle(set(WITHHELD, 1, true));
    current(CLEAN);
    await settle(set(CLEAN, 1));
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(2);
  });

  it('refuses a first rating of an unrated withheld image, and passes it with the grant', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({
      id: WITHHELD,
      metadata: {},
      postId: null,
      nsfwLevel: 0,
    } as never);
    await forbidden(set(WITHHELD, 16));
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    await settle(set(WITHHELD, 16, true));
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('blocks a withheld image for any moderator, rated or not', async () => {
    for (const nsfwLevel of [0, 8]) {
      dbMock.dbWrite.image.findUnique.mockResolvedValue({
        id: WITHHELD,
        metadata: {},
        postId: null,
        nsfwLevel,
      } as never);
      await settle(set(WITHHELD, 32));
    }
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(2);
  });

  // A Knights consensus is checked by its caller (new-order), not here; any other activity is.
  it('lets a Knights consensus through, and refuses the same write as a moderator rating', async () => {
    current(WITHHELD);
    const as = (activity: 'setNsfwLevelKono' | 'setNsfwLevel') =>
      updateImageNsfwLevel({
        id: WITHHELD,
        nsfwLevel: 1,
        userId: 1,
        isModerator: true,
        csamReview: false,
        activity,
      });
    await settle(as('setNsfwLevelKono'));
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    await forbidden(as('setNsfwLevel'));
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('raises a withheld image for any moderator', async () => {
    current(WITHHELD);
    await settle(set(WITHHELD, 16));
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });
});

describe('setImagesNsfwLevel (the moderator image.setNsfwLevel endpoint)', () => {
  beforeEach(() => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([
      { id: CLEAN, nsfwLevel: 8 },
      { id: WITHHELD, nsfwLevel: 8 },
    ] as never);
    dbMock.dbWrite.image.findUnique.mockResolvedValue({
      metadata: {},
      postId: null,
      nsfwLevel: 8,
    } as never);
  });
  const rate = (withheldLevel: number) =>
    setImagesNsfwLevel({
      items: [
        { imageId: CLEAN, nsfwLevel: 1 },
        { imageId: WITHHELD, nsfwLevel: withheldLevel },
      ],
      userId: 1,
      csamReview: false,
    });

  it('writes nothing when a later item would lower a withheld image', async () => {
    await forbidden(rate(1));
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('writes every item when the withheld one is raised', async () => {
    await settle(rate(16));
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(2);
  });
});

describe('toggleImageFlag', () => {
  it('refuses clearing minor on a withheld image', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ minor: true } as never);
    await forbidden(toggleImageFlag({ id: WITHHELD, flag: 'minor', csamReview: false }));
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('sets it on a withheld image, and clears it with the grant', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ minor: false } as never);
    await settle(toggleImageFlag({ id: WITHHELD, flag: 'minor', csamReview: false }));
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ minor: true } as never);
    await settle(toggleImageFlag({ id: WITHHELD, flag: 'minor', csamReview: true }));
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(2);
  });
});

describe('updateImageAcceptableMinor', () => {
  it('refuses accepting a withheld image', async () => {
    await forbidden(
      updateImageAcceptableMinor({
        id: WITHHELD,
        acceptableMinor: true,
        collectionId: 1,
        csamReview: false,
        isModerator: true,
      })
    );
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator a withheld image with the generic refusal', async () => {
    const refused = await updateImageAcceptableMinor({
      id: WITHHELD,
      acceptableMinor: true,
      collectionId: 1,
      csamReview: false,
      isModerator: false,
    }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('accepts a clean image and revokes acceptance on a withheld one', async () => {
    dbMock.dbWrite.image.update.mockResolvedValue({ id: CLEAN, acceptableMinor: true } as never);
    await settle(
      updateImageAcceptableMinor({
        id: CLEAN,
        acceptableMinor: true,
        collectionId: 1,
        csamReview: false,
        isModerator: true,
      })
    );
    await settle(
      updateImageAcceptableMinor({
        id: WITHHELD,
        acceptableMinor: false,
        collectionId: 1,
        csamReview: false,
        isModerator: true,
      })
    );
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(2);
  });
});

describe('resolveIngestionError (article resolveImageScan)', () => {
  it('refuses publishing a withheld image before reading it', async () => {
    await forbidden(
      resolveIngestionError({ id: SIBLING, nsfwLevel: 1, userId: 1, csamReview: false })
    );
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });

  it('reads a clean image on', async () => {
    await notForbidden(
      resolveIngestionError({ id: CLEAN, nsfwLevel: 1, userId: 1, csamReview: false })
    );
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalled();
  });
});

describe('image.rescan', () => {
  it('refuses a withheld image, and rescans it with the grant', async () => {
    await forbidden(rescanImageById({ id: WITHHELD, csamReview: false }));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    await notForbidden(rescanImageById({ id: WITHHELD, csamReview: true }));
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalled();
  });
});

describe('challenge.rescan', () => {
  const challenge = (coverImageId: number) =>
    dbMock.dbWrite.challenge.findUnique.mockResolvedValue({
      title: 't',
      description: null,
      theme: null,
      invitation: null,
      metadata: {},
      coverImageId,
      createdById: OWNER,
    } as never);

  it('refuses a challenge whose cover is withheld', async () => {
    challenge(WITHHELD);
    await forbidden(rescanChallenge({ id: 1, moderatorId: 1, csamReview: false }));
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });

  it('reads a clean cover on', async () => {
    challenge(CLEAN);
    await notForbidden(rescanChallenge({ id: 1, moderatorId: 1, csamReview: false }));
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalled();
  });
});

describe('challenge.playgroundReviewImage', () => {
  const judge = vi.fn(async () => new Response('{}', { status: 500 }));
  beforeEach(() => {
    vi.stubGlobal('fetch', judge);
    dbMock.dbRead.challengeJudge.findUnique.mockResolvedValue({ id: 1 } as never);
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      url: 'key-a',
      user: { username: 'u' },
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a withheld image before it is sent to the judge', async () => {
    await forbidden(playgroundReviewImage({ imageId: WITHHELD, csamReview: false } as never));
    expect(judge).not.toHaveBeenCalled();
  });

  it('sends a clean image to the judge', async () => {
    await notForbidden(playgroundReviewImage({ imageId: CLEAN, csamReview: false } as never));
    expect(judge).toHaveBeenCalled();
  });
});

describe('article.rescanImage', () => {
  beforeEach(() => {
    dbMock.dbWrite.article.findUnique.mockResolvedValue({
      userId: OWNER,
      coverId: WITHHELD,
      bannerId: CLEAN,
    } as never);
    dbMock.dbRead.article.findUnique.mockResolvedValue({
      userId: OWNER,
      coverId: WITHHELD,
      bannerId: CLEAN,
    } as never);
  });
  const rescan = (imageId: number, isModerator: boolean) =>
    rescanArticleImage({
      articleId: 1,
      imageId,
      userId: isModerator ? 1 : OWNER,
      isModerator,
      csamReview: false,
    });

  it("refuses a moderator's rescan of a withheld image", async () => {
    await forbidden(rescan(WITHHELD, true));
  });

  it("passes a moderator's rescan of a clean image", async () => {
    await notForbidden(rescan(CLEAN, true));
  });

  it("refuses the owner's rescan of their own withheld image as it refuses any other", async () => {
    const row = (id: number, blockedFor: string | null) => ({
      id,
      userId: OWNER,
      ingestion: blockedFor ? 'Blocked' : 'Scanned',
      nsfwLevel: 4,
      nsfwLevelLocked: false,
      blockedFor,
      needsReview: null,
    });
    // An image the article may not rescan for an ordinary reason: it is blocked.
    dbMock.dbWrite.image.findUnique.mockResolvedValue(row(CLEAN, 'tos') as never);
    const ordinary = await settle(rescan(CLEAN, false));
    dbMock.dbWrite.image.findUnique.mockResolvedValue(row(WITHHELD, null) as never);
    const withheld = await settle(rescan(WITHHELD, false));

    expect(withheld).toBeInstanceOf(TRPCError);
    expect((withheld as TRPCError).code).toBe((ordinary as TRPCError).code);
    expect((withheld as TRPCError).message).toBe((ordinary as TRPCError).message);
    expect((withheld as TRPCError).message).not.toContain(String(WITHHELD));
    expect(dbMock.dbWrite.image.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("passes the owner's rescan of their own clean image", async () => {
    await notForbidden(rescan(CLEAN, false));
  });
});

describe('tag.disableTags on images', () => {
  it('refuses removing tags from a withheld image', async () => {
    await forbidden(
      disableTags({
        tags: [1],
        entityIds: [CLEAN, WITHHELD],
        entityType: 'image',
        csamReview: false,
      })
    );
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('removes them from a clean image', async () => {
    await notForbidden(
      disableTags({ tags: [1], entityIds: [CLEAN], entityType: 'image', csamReview: false })
    );
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalled();
  });
});

describe('updateCollectionItemsStatus accepting contest entries', () => {
  const COLLECTION = 900;
  const MANAGER = 8;
  const items = { [WITHHELD]: 1, [CLEAN]: 2 } as const;
  beforeEach(() => {
    dbMock.dbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION,
      type: 'Image',
      mode: 'Contest',
      name: 'Contest',
      metadata: {},
    } as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      {
        id: COLLECTION,
        read: 'Public',
        write: 'Review',
        userId: OWNER,
        type: 'Image',
        mode: 'Contest',
        collaborationDisabledAt: null,
        contributorPermissions: ['MANAGE'],
        hasAcceptedSeat: true,
      },
    ]);
    dbMock.dbWrite.collectionItem.findMany.mockImplementation((async (args: any) =>
      Object.entries(items)
        .filter(([, id]) => args.where.id.in.includes(id))
        .map(([imageId, id]) => ({
          id,
          imageId: Number(imageId),
          addedById: null,
          status: 'REVIEW',
          rejectionReason: null,
          rejectionDetail: null,
          articleId: null,
          modelId: null,
          postId: null,
        }))) as never);
  });
  const accept = (
    imageIds: number[],
    who: { isModerator?: boolean; isSystem?: boolean; csamReview?: boolean }
  ) =>
    updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION,
        collectionItemIds: imageIds.map((id) => items[id as keyof typeof items]),
        status: 'ACCEPTED' as never,
      },
      userId: MANAGER,
      ...who,
    });
  // The UPDATE's one bound list: the item ids it accepts.
  const acceptedItemIds = () =>
    (
      dbMock.dbWrite.$executeRaw.mock.calls[0]?.find((arg) =>
        Array.isArray((arg as { values?: unknown })?.values)
      ) as { values: number[] } | undefined
    )?.values;

  it('refuses a moderator without the grant, and writes nothing', async () => {
    await forbidden(accept([CLEAN, WITHHELD], { isModerator: true }));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('accepts it for a moderator with the grant, and a clean entry for any moderator', async () => {
    await accept([CLEAN, WITHHELD], { isModerator: true, csamReview: true });
    expect(acceptedItemIds()).toEqual([items[CLEAN], items[WITHHELD]]);
    vi.clearAllMocks();
    await accept([CLEAN], { isModerator: true });
    expect(acceptedItemIds()).toEqual([items[CLEAN]]);
  });

  it('refuses a contest manager with the generic refusal', async () => {
    const refused = await settle(accept([WITHHELD], {}));
    expect(refused).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('lets the AI review accept the clean entries and leave the withheld one', async () => {
    await accept([CLEAN, WITHHELD], { isSystem: true });
    expect(acceptedItemIds()).toEqual([items[CLEAN]]);
  });
});

describe('addTagVotes', () => {
  const vote = (v: number, who: { isModerator?: boolean; csamReview?: boolean }) =>
    addTagVotes({ userId: 1, type: 'image', id: WITHHELD, tags: [5], vote: v, ...who });

  it("refuses a moderator's downvote on a withheld image, and records nothing", async () => {
    await forbidden(vote(-1, { isModerator: true }));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('records it with the grant, an upvote, and a downvote that carries no moderator weight', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ count: 0 }]);
    await settle(vote(-1, { isModerator: true, csamReview: true }));
    await settle(vote(1, { isModerator: true }));
    await settle(vote(-1, {}));
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(3);
  });
});
