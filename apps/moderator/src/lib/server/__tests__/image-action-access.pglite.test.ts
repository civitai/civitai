import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * Pins the media access rule (`restrictedImageIds` in retracted-media.ts). Image actions refuse a batch with an image the media access rule withholds from this moderator,
 * as the appeal rulings do, and Bulk Image Manager's load sends that image without its media. The
 * reads and the rule run against pglite; the writes an action makes are faked, as a test only needs
 * to see them reached or not.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, writes } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  writes: {
    restoreImages: vi.fn(async (_input: unknown) => ({ ok: true as const, count: 1 })),
    setImageFlag: vi.fn(async (_input: unknown) => ({ ok: true as const })),
    removeImages: vi.fn(async (_input: unknown) => ({ ok: true as const, removed: 1, held: [] })),
    removeAllImagesForUser: vi.fn(async (_input: unknown) => ({ ok: true as const, count: 1 })),
  },
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../user-actions.service')>()),
  ...writes,
}));
// ClickHouse is the boundary: the scanner has no rows, or cannot answer while `scanner.down`.
const { scanner } = vi.hoisted(() => ({ scanner: { down: false } }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    query: async () => {
      if (scanner.down) throw new Error('scanner unavailable');
      return { json: async () => [] };
    },
  }),
}));
const { updateImageNsfwLevel, acceptImage } = vi.hoisted(() => ({
  updateImageNsfwLevel: vi.fn(async (_input: unknown) => undefined),
  acceptImage: vi.fn(async (_input: unknown) => undefined),
}));
vi.mock('../image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-moderation.service')>()),
  acceptImage,
  sendBulkAppealEmails: vi.fn(async () => undefined),
}));
vi.mock('../image-nsfw-level', () => ({ updateImageNsfwLevel }));
// The open item's reports are not what these tests read.
vi.mock('../report-queue-load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../report-queue-load')>()),
  loadItemReports: vi.fn(async () => []),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { reportModerationActions } = await import('../report-actions');
const bulkPage = await import('../../../routes/retool/bulk-image-manager/+page.server');
const lookupPage = await import('../../../routes/retool/image-lookup/+page.server');
const queuePage = await import('../../../routes/images/[slug]/+page.server');
const { collectionImages, loadEntityItem } = await import('../entity-queue-load');

// A routine block reason, kept by the other row on its url, which has not finished its scan.
const WITHHELD = 501;
const CONTROL = 502;

const WITHOUT_GRANT = { id: 2, roles: [] };
const WITH_GRANT = { id: 3, roles: ['moderator:admin'] };
const GRANTS = { 'image.moderate': true };

const reportActions = reportModerationActions('/reports');

let db: PGlite;

beforeEach(async () => {
  for (const write of Object.values(writes)) write.mockClear();
  scanner.down = false;
  updateImageNsfwLevel.mockClear();
  acceptImage.mockClear();
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  await db.exec(
    `CREATE TABLE "CollectionItem" (id SERIAL, "collectionId" INTEGER, "imageId" INTEGER)`
  );
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner'), (8, 'other'), (9, 'clean');
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${WITHHELD}, 'shared-key', 'Blocked', 'moderated', 7),
      (503, 'shared-key', 'Pending', NULL, 8),
      (${CONTROL}, 'control-key', 'Blocked', 'moderated', 7),
      (504, 'clean-key', 'Scanned', NULL, 9);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const event = (user: { id: number; roles: string[] }, fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: new Request('https://mod.test/reports', { method: 'POST', body: form }),
    locals: { user, grants: GRANTS },
  } as never;
};

type Result = { status?: number; data?: { error: string } };

describe('report image actions, without the grant', () => {
  it.each([
    ['restore', {}, writes.restoreImages],
    ['setFlag', { flagValue: 'minor:true' }, writes.setImageFlag],
    ['remove', {}, writes.removeImages],
  ] as const)('refuses %s on a batch with a withheld image', async (action, extra, write) => {
    const result = (await reportActions[action](
      event(WITHOUT_GRANT, { imageIds: `${CONTROL},${WITHHELD}`, ...extra })
    )) as Result;

    expect(result.status).toBe(403);
    expect(result.data?.error).toContain(String(WITHHELD));
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a clean image while the scanner cannot answer', async () => {
    scanner.down = true;
    const result = (await reportActions.restore(
      event(WITHOUT_GRANT, { imageIds: String(CONTROL) })
    )) as Result;
    expect(result.status).toBe(403);
    expect(writes.restoreImages).not.toHaveBeenCalled();
  });

  it('restores a batch with nothing withheld', async () => {
    await reportActions.restore(event(WITHOUT_GRANT, { imageIds: String(CONTROL) }));
    expect(writes.restoreImages).toHaveBeenCalledOnce();
  });
});

describe('report image actions, with the grant', () => {
  it('restores the withheld image', async () => {
    await reportActions.restore(event(WITH_GRANT, { imageIds: String(WITHHELD) }));
    expect(writes.restoreImages).toHaveBeenCalledOnce();
  });
});

describe('Bulk Image Manager', () => {
  const load = (user: { id: number; roles: string[] }) =>
    bulkPage.load({
      url: new URL(
        `https://mod.test/retool/bulk-image-manager?source=imageIds&q=${WITHHELD},${CONTROL}`
      ),
      locals: { user, grants: GRANTS },
    } as never) as Promise<{ batch: { items: (Record<string, unknown> & { id: number })[] } }>;

  const item = async (user: { id: number; roles: string[] }, id: number) =>
    (await load(user)).batch.items.find((i) => i.id === id);

  it('sends a withheld image without its media', async () => {
    expect(await item(WITHOUT_GRANT, WITHHELD)).toMatchObject({
      url: '',
      type: null,
      blockedFor: null,
      restricted: true,
    });
  });

  it('sends an unrestricted image as before', async () => {
    expect(await item(WITHOUT_GRANT, CONTROL)).toMatchObject({
      url: 'control-key',
      restricted: false,
    });
  });

  it('sends a grant holder the withheld image with its media', async () => {
    expect(await item(WITH_GRANT, WITHHELD)).toMatchObject({
      url: 'shared-key',
      restricted: false,
    });
  });

  it.each([
    ['restore', {}, writes.restoreImages],
    ['setFlag', { flagValue: 'minor:true' }, writes.setImageFlag],
    ['remove', {}, writes.removeImages],
  ] as const)('refuses %s on a batch with a withheld image', async (action, extra, write) => {
    const result = (await bulkPage.actions[action](
      event(WITHOUT_GRANT, { imageIds: `${CONTROL},${WITHHELD}`, ...extra })
    )) as Result;

    expect(result.status).toBe(403);
    expect(result.data?.error).toContain(String(WITHHELD));
    expect(write).not.toHaveBeenCalled();
  });
});

describe("Bulk Image Manager's account-wide removal", () => {
  const removeAll = (user: { id: number; roles: string[] }, userId: number, username: string) =>
    bulkPage.actions.removeAllForUser(
      event(user, { userId: String(userId), confirm: username })
    ) as Promise<Result>;

  it('refuses an account with a withheld image without the grant', async () => {
    const result = await removeAll(WITHOUT_GRANT, 7, 'owner');
    expect(result.status).toBe(403);
    expect(result.data?.error).toContain(String(WITHHELD));
    expect(writes.removeAllImagesForUser).not.toHaveBeenCalled();
  });

  it('removes a clean account without the grant', async () => {
    await removeAll(WITHOUT_GRANT, 9, 'clean');
    expect(writes.removeAllImagesForUser).toHaveBeenCalledOnce();
  });

  // Past the cap the account is not read in full, so it is refused unless the grant skips the check.
  describe('an account with more images than are checked', () => {
    beforeEach(async () => {
      await db.exec(`
        INSERT INTO "User" (id, username) VALUES (10, 'large');
        INSERT INTO "Image" (id, url, ingestion, "userId")
          SELECT 990000000 + n, 'large-' || n, 'Scanned', 10 FROM generate_series(1, 1001) n;
      `);
    });

    it('checks an account of exactly the cap in full, and removes it when clean', async () => {
      await db.exec(`DELETE FROM "Image" WHERE id = 990001001`);
      await removeAll(WITHOUT_GRANT, 10, 'large');
      expect(writes.removeAllImagesForUser).toHaveBeenCalledOnce();
    });

    it('is refused without the grant', async () => {
      expect((await removeAll(WITHOUT_GRANT, 10, 'large')).status).toBe(403);
      expect(writes.removeAllImagesForUser).not.toHaveBeenCalled();
    });

    it('is removed for a grant holder', async () => {
      await removeAll(WITH_GRANT, 10, 'large');
      expect(writes.removeAllImagesForUser).toHaveBeenCalledOnce();
    });
  });

  it('refuses an account whose withheld image is past the first page read', async () => {
    await db.exec(`
      INSERT INTO "User" (id, username) VALUES (11, 'paged');
      INSERT INTO "Image" (id, url, ingestion, "userId")
        SELECT 990100000 + n, 'paged-' || n, 'Scanned', 11 FROM generate_series(1, 250) n;
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
        (990100999, 'paged-withheld', 'Blocked', 'CSAM', 11);
    `);
    const result = await removeAll(WITHOUT_GRANT, 11, 'paged');
    expect(result.status).toBe(403);
    expect(result.data?.error).toContain('990100999');
    expect(writes.removeAllImagesForUser).not.toHaveBeenCalled();
  });

  it('removes the account with the withheld image for a grant holder', async () => {
    await removeAll(WITH_GRANT, 7, 'owner');
    expect(writes.removeAllImagesForUser).toHaveBeenCalledOnce();
  });
});

describe('an entity report queue', () => {
  beforeEach(async () => {
    await db.exec(
      `INSERT INTO "CollectionItem" ("collectionId", "imageId") VALUES (60, ${WITHHELD}), (60, ${CONTROL})`
    );
  });

  const item = async (csamReview: boolean, id: number) =>
    (await collectionImages(60, 1, csamReview)).items.find((i) => i.id === id);

  it("sends a collection's withheld image without its media", async () => {
    expect(await item(false, WITHHELD)).toMatchObject({ url: '', type: null, restricted: true });
  });

  it('sends its unrestricted image as before', async () => {
    expect(await item(false, CONTROL)).toMatchObject({ url: 'control-key', restricted: false });
  });

  it('sends a grant holder the withheld image with its media', async () => {
    expect(await item(true, WITHHELD)).toMatchObject({ url: 'shared-key', restricted: false });
  });
});

describe("Image Lookup's flag action", () => {
  const flag = (user: { id: number; roles: string[] }, imageId: number) =>
    lookupPage.actions.setFlag(
      event(user, { imageId: String(imageId), flagValue: 'minor:false' })
    ) as Promise<Result>;

  it('refuses a withheld image without the grant', async () => {
    expect((await flag(WITHOUT_GRANT, WITHHELD)).status).toBe(403);
    expect(writes.setImageFlag).not.toHaveBeenCalled();
  });

  it('flags it for a grant holder', async () => {
    await flag(WITH_GRANT, WITHHELD);
    expect(writes.setImageFlag).toHaveBeenCalledOnce();
  });
});

describe("the image queues' flag and rating actions", () => {
  it('refuse a flag on a batch with a withheld image without the grant', async () => {
    const result = (await queuePage.actions.setFlag(
      event(WITHOUT_GRANT, { imageIds: `${CONTROL},${WITHHELD}`, flagValue: 'minor:false' })
    )) as Result;
    expect(result.status).toBe(403);
    expect(writes.setImageFlag).not.toHaveBeenCalled();
  });

  it('flag it for a grant holder', async () => {
    await queuePage.actions.setFlag(
      event(WITH_GRANT, { imageIds: String(WITHHELD), flagValue: 'minor:false' })
    );
    expect(writes.setImageFlag).toHaveBeenCalledOnce();
  });

  it('refuse a rating on a batch with a withheld image without the grant', async () => {
    const result = (await queuePage.actions.setRating(
      event(WITHOUT_GRANT, { imageIds: `${CONTROL},${WITHHELD}`, nsfwLevel: '1' })
    )) as Result;
    expect(result.status).toBe(403);
    expect(updateImageNsfwLevel).not.toHaveBeenCalled();
  });

  it('rate it for a grant holder', async () => {
    await queuePage.actions.setRating(
      event(WITH_GRANT, { imageIds: String(WITHHELD), nsfwLevel: '1' })
    );
    expect(updateImageNsfwLevel).toHaveBeenCalledOnce();
  });
});

describe("the image queues' accept actions", () => {
  it('refuse to accept a withheld image without the grant', async () => {
    const result = (await queuePage.actions.accept(
      event(WITHOUT_GRANT, { imageId: String(WITHHELD) })
    )) as Result;
    expect(result.status).toBe(403);
    expect(acceptImage).not.toHaveBeenCalled();
  });

  it('accept it for a grant holder', async () => {
    await queuePage.actions.accept(event(WITH_GRANT, { imageId: String(WITHHELD) }));
    expect(acceptImage).toHaveBeenCalledOnce();
  });

  it('refuse a bulk accept with a withheld image without the grant', async () => {
    const result = (await queuePage.actions.bulkAccept(
      event(WITHOUT_GRANT, { imageIds: `${CONTROL},${WITHHELD}` })
    )) as Result;
    expect(result.status).toBe(403);
    expect(acceptImage).not.toHaveBeenCalled();
  });

  it('bulk accept it for a grant holder', async () => {
    await queuePage.actions.bulkAccept(event(WITH_GRANT, { imageIds: String(WITHHELD) }));
    expect(acceptImage).toHaveBeenCalledOnce();
  });
});

describe('an article report', () => {
  beforeEach(async () => {
    await db.exec(`
      ALTER TABLE "Article" ADD COLUMN "userId" INTEGER, ADD COLUMN title TEXT,
        ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), ADD COLUMN "updatedAt" TIMESTAMP(3),
        ADD COLUMN "publishedAt" TIMESTAMP(3), ADD COLUMN status TEXT NOT NULL DEFAULT 'Published',
        ADD COLUMN availability TEXT NOT NULL DEFAULT 'Public',
        ADD COLUMN unlisted BOOLEAN NOT NULL DEFAULT false, ADD COLUMN nsfw BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN "tosViolation" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN cover TEXT,
        ADD COLUMN "nsfwLevel" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "userNsfwLevel" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN "moderatorNsfwLevel" INTEGER, ADD COLUMN "moderatorNsfwLevelBasis" TEXT,
        ADD COLUMN ingestion TEXT NOT NULL DEFAULT 'Scanned', ADD COLUMN "contentScannedAt" TIMESTAMP(3),
        ADD COLUMN "scanRequestedAt" TIMESTAMP(3), ADD COLUMN "lockedProperties" TEXT[],
        ADD COLUMN metadata JSONB, ADD COLUMN content TEXT;
      INSERT INTO "Article" (id, "userId", title, cover, content) VALUES (70, 7, 'a', 'shared-key',
        '<p>x</p><edge-media url="shared-key" type="image"><edge-media url="control-key" type="image"><edge-media url="missing-key" type="image">');
      INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES (${CONTROL}, 70, 'Article');
    `);
  });

  const page = async (user: { id: number; roles: string[] }) =>
    JSON.stringify(
      await loadEntityItem(
        'article',
        70,
        { user, grants: GRANTS } as never,
        new URL('https://mod.test/reports/article/70')
      )
    );

  it('sends no withheld or unknown image key anywhere in the page data', async () => {
    const data = await page(WITHOUT_GRANT);
    expect(data).not.toContain('shared-key');
    expect(data).not.toContain('missing-key');
    expect(data).toContain('control-key');
  });

  it('sends a grant holder the withheld image key', async () => {
    expect(await page(WITH_GRANT)).toContain('shared-key');
  });
});
