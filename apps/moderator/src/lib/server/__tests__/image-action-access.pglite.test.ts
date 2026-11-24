import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { applyGrants } from '../access';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * Pins the media access rule (`restrictedImageIds` in retracted-media.ts, civitai/civitai#10170). Image actions refuse a batch with an image the media access rule withholds from this moderator,
 * as the appeal rulings do, and Bulk Image Manager's load sends that image without its media. The
 * reads and the rule run against pglite; the writes an action makes are faked, as a test only needs
 * to see them reached or not. So a case that acts proves only that the gate lets the call through.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, writes } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  writes: {
    restoreImages: vi.fn(async (_input: unknown) => ({ ok: true as const, count: 1 })),
    setImageFlag: vi.fn(async (_input: unknown) => ({ ok: true as const })),
    removeImages: vi.fn(async (_input: unknown) => ({ ok: true as const, removed: 1, held: [] })),
    removeAllImagesForUser: vi.fn(async (_input: unknown) => ({ ok: true as const, count: 1 })),
    purgeAllContent: vi.fn(async (_input: unknown) => ({ ok: true as const })),
    deleteAccount: vi.fn(async (_input: unknown) => ({ ok: true as const })),
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
const {
  updateImageNsfwLevel,
  acceptImage,
  blockImage,
  dismissFromCsamQueue,
  dismissUserFromCsamQueue,
} = vi.hoisted(() => ({
  updateImageNsfwLevel: vi.fn(async (_input: unknown) => undefined),
  acceptImage: vi.fn(async (_input: unknown) => undefined),
  blockImage: vi.fn(async (_input: unknown) => ({})),
  dismissFromCsamQueue: vi.fn(async (_input: unknown) => ({ ok: true as const })),
  dismissUserFromCsamQueue: vi.fn(async (_input: unknown) => ({ ok: true as const, dismissed: 1 })),
}));
const { resolveImageAppeal } = vi.hoisted(() => ({
  resolveImageAppeal: vi.fn(async (_input: unknown) => true),
}));
vi.mock('../image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-moderation.service')>()),
  acceptImage,
  blockImage,
  dismissFromCsamQueue,
  dismissUserFromCsamQueue,
  resolveImageAppeal,
  sendBulkAppealEmails: vi.fn(async () => undefined),
}));
vi.mock('../image-nsfw-level', () => ({ updateImageNsfwLevel }));
const { resolveIngestionError, ruleOnInquisitorItem } = vi.hoisted(() => ({
  resolveIngestionError: vi.fn(async (_input: unknown) => undefined),
  ruleOnInquisitorItem: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
}));
vi.mock('../ingestion.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ingestion.service')>()),
  resolveIngestionError,
}));
const { confirmRemoval, declineRemoval } = vi.hoisted(() => ({
  confirmRemoval: vi.fn(async (_input: unknown) => ({ ok: true as const, status: 'Confirmed' })),
  declineRemoval: vi.fn(async (_input: unknown) => ({ ok: true as const, status: 'Declined' })),
}));
vi.mock('../image-removal-confirmation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-removal-confirmation.service')>()),
  confirmRemoval,
  declineRemoval,
}));
vi.mock('../knights/inquisitor.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knights/inquisitor.service')>()),
  ruleOnInquisitorItem,
}));
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
const { withheldMedia } = await import('../retracted-media');
const comicsPage = await import('../../../routes/comics-review/+page.server');
const ratingsPage = await import('../../../routes/images/ratings/+page.server');
const downleveledPage = await import('../../../routes/images/downleveled/+page.server');
const sweepPage = await import('../../../routes/retool/front-page-audit/[media]/+page.server');
const userLookupPage = await import('../../../routes/retool/user-lookup/[section]/+page.server');
const ingestionPage = await import('../../../routes/images/ingestion-errors/+page.server');
const inquisitorPage = await import('../../../routes/knights-of-new-order/inquisitor/+page.server');
const { getImageLookup } = await import('../image-lookup.service');
const reRemovalsPage = await import('../../../routes/images/re-removals/+page.server');

// A routine block reason, kept by the other row on its url, which is in the CSAM queue.
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
  blockImage.mockClear();
  dismissFromCsamQueue.mockClear();
  dismissUserFromCsamQueue.mockClear();
  resolveIngestionError.mockClear();
  ruleOnInquisitorItem.mockClear();
  resolveImageAppeal.mockClear();
  confirmRemoval.mockClear();
  declineRemoval.mockClear();
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  await db.exec(
    `CREATE TABLE "CollectionItem" (id SERIAL, "collectionId" INTEGER, "imageId" INTEGER)`
  );
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner'), (8, 'other'), (9, 'clean');
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${WITHHELD}, 'shared-key', 'Blocked', 'moderated', 7),
      (503, 'shared-key', 'Scanned', NULL, 8),
      (${CONTROL}, 'control-key', 'Blocked', 'moderated', 7),
      (504, 'clean-key', 'Scanned', NULL, 9);
    UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 503;
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

  // The moderator-view rule reads Postgres only: a scanner outage withholds nothing.
  it('acts on a scanned or retracted image nothing withholds while the scanner cannot answer', async () => {
    scanner.down = true;
    await queuePage.actions.accept(event(WITHOUT_GRANT, { imageId: '504' }));
    await queuePage.actions.block(event(WITHOUT_GRANT, { imageId: String(CONTROL) }));
    await reportActions.restore(event(WITHOUT_GRANT, { imageIds: String(CONTROL) }));
    expect(acceptImage).toHaveBeenCalledOnce();
    expect(blockImage).toHaveBeenCalledOnce();
    expect(writes.restoreImages).toHaveBeenCalledOnce();
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
    expect(await item(WITHOUT_GRANT, WITHHELD)).toMatchObject(withheldMedia());
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

  it('withholds the whole batch, rather than failing to load, when one chunk of the read fails', async () => {
    // One image past a chunk, so the read takes two transactions.
    const filler = Array.from({ length: 50 }, (_, k) => 990000400 + k);
    await db.exec(`INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      ${filler.map((id) => `(${id}, 'filler-${id}', 'Scanned', NULL, 9)`).join(', ')}`);
    const loadAll = async () =>
      (
        (await bulkPage.load({
          url: new URL(
            `https://mod.test/retool/bulk-image-manager?source=imageIds&q=${[
              CONTROL,
              ...filler,
            ].join(',')}`
          ),
          locals: { user: WITHOUT_GRANT, grants: GRANTS },
        } as never)) as { batch: { items: { id: number; restricted: boolean }[] } }
      ).batch.items;
    expect((await loadAll()).filter((i) => i.restricted)).toEqual([]);

    const client = dbHandle.current as { transaction: () => unknown };
    const transaction = client.transaction.bind(client);
    let calls = 0;
    vi.spyOn(client, 'transaction').mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw new Error('canceling statement due to statement timeout');
      return transaction();
    });
    const items = await loadAll();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(items).toHaveLength(51);
    expect(items.every((i) => i.restricted)).toBe(true);
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

  // Read in id order, so the highest id is on the last page.
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

describe("the image queues' removal and dismiss actions", () => {
  const csam = (user: { id: number; roles: string[] }, fields: Record<string, string>) =>
    ({ ...(event(user, fields) as object), params: { slug: 'csam' } } as never);

  it('refuse to remove a withheld image without the grant', async () => {
    const result = (await queuePage.actions.block(
      event(WITHOUT_GRANT, { imageId: String(WITHHELD) })
    )) as Result;
    expect(result.status).toBe(403);
    expect(blockImage).not.toHaveBeenCalled();
  });

  it('remove it for a grant holder', async () => {
    await queuePage.actions.block(event(WITH_GRANT, { imageId: String(WITHHELD) }));
    expect(blockImage).toHaveBeenCalledOnce();
  });

  it('refuse a bulk removal with one withheld image without the grant, removing none', async () => {
    const result = (await queuePage.actions.bulkBlock(
      event(WITHOUT_GRANT, { imageIds: `${CONTROL},${WITHHELD}` })
    )) as Result;
    expect(result.status).toBe(403);
    expect(blockImage).not.toHaveBeenCalled();
  });

  it('refuse to dismiss a withheld image without the grant', async () => {
    const result = (await queuePage.actions.dismissFlag(
      csam(WITHOUT_GRANT, { imageId: String(WITHHELD), version: 'v' })
    )) as Result;
    expect(result.status).toBe(403);
    expect(dismissFromCsamQueue).not.toHaveBeenCalled();
  });

  it("refuse to dismiss an account's images with one withheld without the grant", async () => {
    const result = (await queuePage.actions.dismissUserFlags(
      csam(WITHOUT_GRANT, { userId: '7', expectedCount: '2', version: 'v' })
    )) as Result;
    expect(result.status).toBe(403);
    expect(dismissUserFromCsamQueue).not.toHaveBeenCalled();
  });

  it('dismiss them for a grant holder', async () => {
    await queuePage.actions.dismissFlag(
      csam(WITH_GRANT, { imageId: String(WITHHELD), version: 'v' })
    );
    await queuePage.actions.dismissUserFlags(
      csam(WITH_GRANT, { userId: '7', expectedCount: '2', version: 'v' })
    );
    expect(dismissFromCsamQueue).toHaveBeenCalledOnce();
    expect(dismissUserFromCsamQueue).toHaveBeenCalledOnce();
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

// civitai/civitai#10170: each action that writes to one image refuses a withheld one without the
// grant, writes nothing, and still acts on an image nothing withholds.
describe('the single-image write actions on other pages', () => {
  type Action = (e: never) => Promise<unknown>;
  const cases: [string, Action, (id: number) => Record<string, string>, () => unknown][] = [
    [
      'comics review approve',
      comicsPage.actions.approve as Action,
      (id) => ({ imageId: String(id) }),
      () => acceptImage,
    ],
    [
      'comics review block',
      comicsPage.actions.block as Action,
      (id) => ({ imageId: String(id) }),
      () => blockImage,
    ],
    [
      'rating review',
      ratingsPage.actions.setLevel as Action,
      (id) => ({ id: String(id), nsfwLevel: '1' }),
      () => updateImageNsfwLevel,
    ],
    [
      'downleveled review',
      downleveledPage.actions.setLevel as Action,
      (id) => ({ id: String(id), nsfwLevel: '1' }),
      () => updateImageNsfwLevel,
    ],
  ];

  it.each(cases)(
    '%s refuses a withheld image without the grant',
    async (_, action, fields, write) => {
      const result = (await action(event(WITHOUT_GRANT, fields(WITHHELD)))) as Result;
      expect(result.status).toBe(403);
      expect(write()).not.toHaveBeenCalled();
    }
  );

  it.each(cases)(
    '%s acts on an image nothing withholds, without the grant',
    async (_, action, fields, write) => {
      await action(event(WITHOUT_GRANT, fields(CONTROL)));
      expect(write()).toHaveBeenCalledOnce();
    }
  );

  it.each(cases)(
    '%s acts on the withheld image for a grant holder',
    async (_, action, fields, write) => {
      await action(event(WITH_GRANT, fields(WITHHELD)));
      expect(write()).toHaveBeenCalledOnce();
    }
  );

  describe("the front page sweep's rating", () => {
    // A role that may open the sweep, and not the held-media page.
    const SWEEPER = { id: 4, roles: ['moderator:sweeper'] };
    beforeEach(() => applyGrants({ '/retool/front-page-audit': ['moderator:sweeper'] }));
    afterEach(() => applyGrants({}));
    const rate = (user: { id: number; roles: string[] }, imageId: number) =>
      (sweepPage.actions.setRating as Action)(
        event(user, { imageId: String(imageId), nsfwLevel: '1' })
      ).catch(() => undefined) as Promise<Result | undefined>;

    it('refuses a withheld image without the grant', async () => {
      expect((await rate(SWEEPER, WITHHELD))?.status).toBe(403);
      expect(updateImageNsfwLevel).not.toHaveBeenCalled();
    });

    it('rates an image nothing withholds, without the grant', async () => {
      await rate(SWEEPER, CONTROL);
      expect(updateImageNsfwLevel).toHaveBeenCalledOnce();
    });

    it('rates the withheld image for a grant holder', async () => {
      await rate(WITH_GRANT, WITHHELD);
      expect(updateImageNsfwLevel).toHaveBeenCalledOnce();
    });
  });
});

// A gate that refused everyone would pass the refusals above.
describe("the image queues' gated actions, on an image nothing withholds, without the grant", () => {
  const csam = (fields: Record<string, string>) =>
    ({ ...(event(WITHOUT_GRANT, fields) as object), params: { slug: 'csam' } } as never);

  it('flag, rate, accept and remove it', async () => {
    await queuePage.actions.setFlag(
      event(WITHOUT_GRANT, { imageIds: String(CONTROL), flagValue: 'minor:false' })
    );
    await queuePage.actions.setRating(
      event(WITHOUT_GRANT, { imageIds: String(CONTROL), nsfwLevel: '1' })
    );
    await queuePage.actions.accept(event(WITHOUT_GRANT, { imageId: String(CONTROL) }));
    await queuePage.actions.bulkAccept(event(WITHOUT_GRANT, { imageIds: String(CONTROL) }));
    await queuePage.actions.block(event(WITHOUT_GRANT, { imageId: String(CONTROL) }));
    await queuePage.actions.bulkBlock(event(WITHOUT_GRANT, { imageIds: String(CONTROL) }));
    expect({
      flag: writes.setImageFlag.mock.calls.length,
      rate: updateImageNsfwLevel.mock.calls.length,
      accept: acceptImage.mock.calls.length,
      block: blockImage.mock.calls.length,
    }).toEqual({ flag: 1, rate: 1, accept: 2, block: 2 });
  });

  it('dismiss it, and a clean account', async () => {
    await queuePage.actions.dismissFlag(csam({ imageId: String(CONTROL), version: 'v' }));
    await queuePage.actions.dismissUserFlags(
      csam({ userId: '9', expectedCount: '1', version: 'v' })
    );
    expect(dismissFromCsamQueue).toHaveBeenCalledOnce();
    expect(dismissUserFromCsamQueue).toHaveBeenCalledOnce();
  });
});

describe("User Lookup's account-wide removals", () => {
  const ACCOUNT_GRANTS = { 'user.purge': true, 'user.deleteAccount': true };
  const act = (
    action: 'purgeContent' | 'deleteAccount',
    user: { id: number; roles: string[] },
    userId: number,
    username: string
  ) => {
    const form = new FormData();
    form.set('userId', String(userId));
    form.set('confirm', username);
    form.set('username', username);
    form.set('removeImages', 'true');
    return (userLookupPage.actions[action] as (e: never) => Promise<unknown>)({
      request: new Request('https://mod.test/retool/user-lookup', { method: 'POST', body: form }),
      locals: { user, grants: ACCOUNT_GRANTS },
    } as never) as Promise<Result>;
  };

  it.each([
    ['purgeContent', () => writes.purgeAllContent],
    ['deleteAccount', () => writes.deleteAccount],
  ] as const)(
    '%s refuses an account with a withheld image without the grant',
    async (action, write) => {
      expect((await act(action, WITHOUT_GRANT, 7, 'owner')).status).toBe(403);
      expect(write()).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['purgeContent', () => writes.purgeAllContent],
    ['deleteAccount', () => writes.deleteAccount],
  ] as const)('%s acts on a clean account without the grant', async (action, write) => {
    await act(action, WITHOUT_GRANT, 9, 'clean');
    expect(write()).toHaveBeenCalledOnce();
  });

  it.each([
    ['purgeContent', () => writes.purgeAllContent],
    ['deleteAccount', () => writes.deleteAccount],
  ] as const)('%s acts on the account for a grant holder', async (action, write) => {
    await act(action, WITH_GRANT, 7, 'owner');
    expect(write()).toHaveBeenCalledOnce();
  });
});

// Rows nothing retracts or holds are decided on Postgres alone, their url siblings included.
describe('a live image sharing its url, without the grant', () => {
  const SIGNAL_SHARED = 990000001;
  const CLEAN_SHARED = 990000003;
  beforeEach(() =>
    db.exec(`
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
        (${SIGNAL_SHARED}, 'signal-shared-key', 'Scanned', NULL, 9),
        (990000002, 'signal-shared-key', 'Blocked', 'unrecognised-reason', 8),
        (${CLEAN_SHARED}, 'clean-shared-key', 'Scanned', NULL, 9),
        (990000004, 'clean-shared-key', 'Scanned', NULL, 8);
    `)
  );

  // A block reason is not a CSAM mark unless it is CSAM itself.
  it('is acted on when a sibling on its url carries an unrecognised block reason', async () => {
    await queuePage.actions.accept(event(WITHOUT_GRANT, { imageId: String(SIGNAL_SHARED) }));
    expect(acceptImage).toHaveBeenCalledOnce();
  });

  it('is acted on when every sibling on its url is clean, even while the scanner cannot answer', async () => {
    scanner.down = true;
    await queuePage.actions.accept(event(WITHOUT_GRANT, { imageId: String(CLEAN_SHARED) }));
    expect(acceptImage).toHaveBeenCalledOnce();
  });
});

describe("the ingestion-error queue's resolve", () => {
  const CLEAN_ERROR = 990000010;
  beforeEach(() =>
    db.exec(`INSERT INTO "Image" (id, url, ingestion, "userId") VALUES
      (${CLEAN_ERROR}, 'error-key', 'Error', 9)`)
  );
  const resolve = (user: { id: number; roles: string[] }, id: number) =>
    ingestionPage.actions.resolve(
      event(user, { id: String(id), nsfwLevel: '1' })
    ) as Promise<Result>;

  it('refuses a withheld image without the grant, writing nothing', async () => {
    expect((await resolve(WITHOUT_GRANT, WITHHELD)).status).toBe(403);
    expect(resolveIngestionError).not.toHaveBeenCalled();
  });

  it('resolves a clean Error image without the grant', async () => {
    await resolve(WITHOUT_GRANT, CLEAN_ERROR);
    expect(resolveIngestionError).toHaveBeenCalledOnce();
  });

  it('resolves the withheld image for a grant holder', async () => {
    await resolve(WITH_GRANT, WITHHELD);
    expect(resolveIngestionError).toHaveBeenCalledOnce();
  });

  it('lists a withheld Error image without its media, and a clean one with it', async () => {
    // The queue's SQL casts to the enum this schema keeps as text.
    await db.exec(`CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
      UPDATE "Image" SET "nsfwLevel" = 0, "createdAt" = now() - interval '2 hours'
      WHERE id IN (${CLEAN_ERROR}, 503);
      UPDATE "Image" SET ingestion = 'Error' WHERE id = 503`);
    const cards = async (user: { id: number; roles: string[] }) => {
      const data = (await ingestionPage.load({
        url: new URL('https://mod.test/images/ingestion-errors'),
        locals: { user, grants: GRANTS },
      } as never)) as { items: { id: number; url: string; restricted: boolean }[] };
      return new Map(data.items.map((i) => [i.id, { url: i.url, restricted: i.restricted }]));
    };
    const without = await cards(WITHOUT_GRANT);
    expect(without.get(503)).toEqual({ url: '', restricted: true });
    expect(without.get(CLEAN_ERROR)).toEqual({ url: 'error-key', restricted: false });
    expect((await cards(WITH_GRANT)).get(503)).toEqual({ url: 'shared-key', restricted: false });
  });
});

describe("the front page sweep's tag vote", () => {
  const SWEEPER = { id: 4, roles: ['moderator:sweeper'] };
  beforeEach(() => applyGrants({ '/retool/front-page-audit': ['moderator:sweeper'] }));
  afterEach(() => applyGrants({}));

  it('refuses a withheld image without the grant', async () => {
    const result = (await (sweepPage.actions.voteTag as (e: never) => Promise<unknown>)(
      event(SWEEPER, { imageId: String(WITHHELD), tagId: '1', direction: 'up' })
    )) as Result;
    expect(result.status).toBe(403);
  });
});

describe("the Inquisitor's ruling", () => {
  const KNIGHT = { id: 5, roles: ['moderator:knight'] };
  const PATH = '/knights-of-new-order/inquisitor';
  beforeEach(async () => {
    applyGrants({ [PATH]: ['moderator:knight'] });
    await db.exec(`CREATE TABLE "KnightsQueueItem" (id INTEGER PRIMARY KEY, "imageId" INTEGER);
      INSERT INTO "KnightsQueueItem" (id, "imageId") VALUES (1, ${WITHHELD}), (2, ${CONTROL})`);
  });
  afterEach(() => applyGrants({}));
  const rule = (user: { id: number; roles: string[] }, itemId: number) =>
    inquisitorPage.actions.rule({
      ...(event(user, { itemId: String(itemId), level: '1' }) as object),
      url: new URL(`https://mod.test${PATH}`),
    } as never) as Promise<Result>;

  it('refuses an item whose image is withheld, without the grant', async () => {
    expect((await rule(KNIGHT, 1)).status).toBe(403);
    expect(ruleOnInquisitorItem).not.toHaveBeenCalled();
  });

  it('rules on an item whose image nothing withholds, without the grant', async () => {
    await rule(KNIGHT, 2);
    expect(ruleOnInquisitorItem).toHaveBeenCalledOnce();
  });

  it('rules on the withheld item for a grant holder', async () => {
    await rule(WITH_GRANT, 1);
    expect(ruleOnInquisitorItem).toHaveBeenCalledOnce();
  });
});

describe("Image Lookup's activity for a withheld image", () => {
  beforeEach(() =>
    db.exec(`INSERT INTO "ModActivity" ("userId", "entityType", "entityId", activity, "createdAt") VALUES
      (3, 'image', ${WITHHELD}, 'dismissFromCsamQueue', now()),
      (3, 'image', ${WITHHELD}, 'heldMedia:view', now())`)
  );

  it('lists none without the grant', async () => {
    const found = await getImageLookup(WITHHELD, { csamReview: false });
    expect(found?.modActivity.rows).toEqual([]);
  });

  it('lists it for a grant holder', async () => {
    const found = await getImageLookup(WITHHELD, { csamReview: true });
    expect(found?.modActivity.rows.map((row) => row.activity).sort()).toEqual([
      'dismissFromCsamQueue',
      'heldMedia:view',
    ]);
  });
});

describe("the re-removal queue's confirm and decline", () => {
  beforeEach(() =>
    db.exec(`CREATE TABLE "ImageRemovalConfirmation" (id INTEGER PRIMARY KEY, "imageId" INTEGER);
      INSERT INTO "ImageRemovalConfirmation" (id, "imageId") VALUES (1, ${WITHHELD}), (2, ${CONTROL})`)
  );
  const decide = (
    action: 'confirm' | 'decline',
    user: { id: number; roles: string[] },
    id: number
  ) => {
    const form = new FormData();
    form.set('id', String(id));
    return (reRemovalsPage.actions[action] as (e: never) => Promise<unknown>)({
      request: new Request('https://mod.test/images/re-removals', { method: 'POST', body: form }),
      locals: { user, grants: { 'image.removal.confirm': true } },
    } as never) as Promise<Result>;
  };

  it.each([
    ['confirm', () => confirmRemoval],
    ['decline', () => declineRemoval],
  ] as const)(
    '%s refuses a withheld image without the grant, writing nothing',
    async (action, run) => {
      expect((await decide(action, WITHOUT_GRANT, 1)).status).toBe(403);
      expect(run()).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['confirm', () => confirmRemoval],
    ['decline', () => declineRemoval],
  ] as const)('%s decides an image nothing withholds, without the grant', async (action, run) => {
    await decide(action, WITHOUT_GRANT, 2);
    expect(run()).toHaveBeenCalledOnce();
  });

  it.each([
    ['confirm', () => confirmRemoval],
    ['decline', () => declineRemoval],
  ] as const)('%s decides the withheld image for a grant holder', async (action, run) => {
    await decide(action, WITH_GRANT, 1);
    expect(run()).toHaveBeenCalledOnce();
  });
});

describe("the re-removal queue's list", () => {
  beforeEach(() =>
    db.exec(`CREATE TABLE "ImageRemovalConfirmation" (
        id INTEGER PRIMARY KEY, "imageId" INTEGER, "appealId" INTEGER, status TEXT, source TEXT,
        "violationType" TEXT, "violationDetails" TEXT, "reportIds" INTEGER[],
        "requestedAt" TIMESTAMP(3) DEFAULT now(), "requestedById" INTEGER,
        "decidedAt" TIMESTAMP(3), "decidedById" INTEGER, "decisionNote" TEXT
      );
      INSERT INTO "Appeal"
        (id, "userId", "entityType", "entityId", "appealMessage", "resolvedReason", "resolvedMessage")
      VALUES
        (990000041, 7, 'Image', ${WITHHELD}, 'appeal text', 'misclassified', 'reply text'),
        (990000042, 7, 'Image', ${CONTROL}, 'appeal text', 'misclassified', 'reply text');
      INSERT INTO "AppealDecisionRecord" ("appealId", "removalLabel") VALUES
        (990000041, 'overturned-label'), (990000042, 'overturned-label');
      INSERT INTO "ImageRemovalConfirmation"
        (id, "imageId", "appealId", status, source, "violationType", "violationDetails", "reportIds",
          "decisionNote")
      VALUES
        (1, ${WITHHELD}, 990000041, 'Pending', 'report', 'some-reason', 'details', '{990000043}', 'note'),
        (2, ${CONTROL}, 990000042, 'Pending', 'report', 'some-reason', 'details', '{990000044}', 'note')`)
  );
  const list = async (user: { id: number; roles: string[] }) => {
    const data = (await reRemovalsPage.load({
      url: new URL('https://mod.test/images/re-removals'),
      locals: { user },
    } as never)) as { items: (Record<string, unknown> & { imageId: number })[] };
    return new Map(data.items.map((item) => [item.imageId, item]));
  };
  const REASON = {
    violationType: 'some-reason',
    violationDetails: 'details',
    removalLabel: 'overturned-label',
    appealMessage: 'appeal text',
    resolvedReason: 'misclassified',
    resolvedMessage: 'reply text',
    decisionNote: 'note',
  };

  it('lists a withheld image without its media or its removal reason, without the grant', async () => {
    const items = await list(WITHOUT_GRANT);
    expect(items.get(WITHHELD)).toMatchObject({
      url: '',
      mediaType: null,
      violationType: null,
      violationDetails: null,
      reportIds: [],
      removalLabel: null,
      appealMessage: null,
      resolvedReason: null,
      resolvedMessage: null,
      decisionNote: null,
      restricted: true,
    });
    expect(items.get(CONTROL)).toMatchObject({
      url: 'control-key',
      ...REASON,
      reportIds: [990000044],
    });
  });

  it('lists everything for a grant holder', async () => {
    const items = await list(WITH_GRANT);
    expect(items.get(WITHHELD)).toMatchObject({
      url: 'shared-key',
      ...REASON,
      reportIds: [990000043],
    });
  });
});

describe("a withheld image's overturned removal label", () => {
  beforeEach(() =>
    db.exec(`INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status) VALUES
        (990000050, 7, 'Image', ${WITHHELD}, 'Approved');
      INSERT INTO "AppealDecisionRecord" ("appealId", "removalLabel") VALUES (990000050, 'overturned-label')`)
  );
  const bulkItem = async (user: { id: number; roles: string[] }) =>
    (
      (await bulkPage.load({
        url: new URL(`https://mod.test/retool/bulk-image-manager?source=imageIds&q=${WITHHELD}`),
        locals: { user, grants: GRANTS },
      } as never)) as {
        batch: { items: { id: number; approvedAppeal: { removalLabel: string | null } | null }[] };
      }
    ).batch.items.find((i) => i.id === WITHHELD);

  it('is not sent without the grant, in Bulk Image Manager or Image Lookup', async () => {
    expect((await bulkItem(WITHOUT_GRANT))?.approvedAppeal).toMatchObject({ removalLabel: null });
    expect((await getImageLookup(WITHHELD, { csamReview: false }))?.approvedAppeal).toMatchObject({
      removalLabel: null,
    });
  });

  it('is sent to a grant holder', async () => {
    expect((await bulkItem(WITH_GRANT))?.approvedAppeal).toMatchObject({
      removalLabel: 'overturned-label',
    });
    expect((await getImageLookup(WITHHELD, { csamReview: true }))?.approvedAppeal).toMatchObject({
      removalLabel: 'overturned-label',
    });
  });
});

// civitai/civitai#10170: an image deleted since the page loaded is the write's to report, not a refusal.
describe('a batch with an image deleted since the page loaded, without the grant', () => {
  const DELETED = 990999999;
  const ruling = { status: 'Rejected', resolvedReason: 'violation-confirmed' };

  it('rules the rest of an appeal batch', async () => {
    const result = (await queuePage.actions.bulkResolveAppeal(
      event(WITHOUT_GRANT, { imageIds: `${CONTROL},${DELETED}`, ...ruling })
    )) as Result | undefined;
    expect(result?.status).not.toBe(403);
    expect(resolveImageAppeal).toHaveBeenCalledWith(expect.objectContaining({ imageId: CONTROL }));
  });

  it('still refuses an appeal batch with a withheld image in it', async () => {
    const result = (await queuePage.actions.bulkResolveAppeal(
      event(WITHOUT_GRANT, { imageIds: `${WITHHELD},${DELETED}`, ...ruling })
    )) as Result;
    expect(result.status).toBe(403);
    expect(resolveImageAppeal).not.toHaveBeenCalled();
  });

  it('acts on the rest', async () => {
    await reportActions.remove(event(WITHOUT_GRANT, { imageIds: `${CONTROL},${DELETED}` }));
    expect(writes.removeImages).toHaveBeenCalledOnce();
  });

  it('is still refused when another image in it is withheld', async () => {
    const result = (await reportActions.remove(
      event(WITHOUT_GRANT, { imageIds: `${WITHHELD},${DELETED}` })
    )) as Result;
    expect(result.status).toBe(403);
    expect(result.data?.error).not.toContain(String(DELETED));
    expect(writes.removeImages).not.toHaveBeenCalled();
  });
});

// civitai/civitai#10170: the main queues draw a withheld card as restricted, as the appeal queue does.
describe('the reported and review queues, without the grant', () => {
  const reportsImagePage = () => import('../../../routes/reports/image/+page.server');
  // Withheld because the other row on its url is blocked as CSAM.
  const KEPT = 990000080;
  const CLEAN = 990000082;
  beforeEach(() =>
    db.exec(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS image TEXT;
      CREATE TABLE IF NOT EXISTS "ModerationRule" (id INTEGER PRIMARY KEY, action TEXT, definition JSONB);
      CREATE TABLE IF NOT EXISTS "ModerationRuleVersion" ("ruleId" INTEGER, action TEXT);
      CREATE TABLE IF NOT EXISTS "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
      CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
      CREATE TABLE IF NOT EXISTS "JobQueue" ("type" TEXT, "entityType" "EntityType", "entityId" INTEGER, "data" JSONB);
      CREATE TABLE IF NOT EXISTS "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, "disabled" BOOLEAN);
      INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId", "needsReview") VALUES
        (${KEPT}, 'queue-key', 'Scanned', NULL, 9, 'minor'),
        (990000081, 'queue-key', 'Blocked', 'CSAM', 8, NULL),
        (${CLEAN}, 'queue-clean-key', 'Scanned', NULL, 9, 'minor');
      INSERT INTO "Report" (id, "userId", reason, status, details, "createdAt") VALUES
        (990000070, 8, 'TOSViolation', 'Pending', '{}', now()),
        (990000071, 8, 'TOSViolation', 'Pending', '{}', now());
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${KEPT}, 990000070), (${CLEAN}, 990000071)`)
  );
  type Card = Record<string, unknown> & { id: number };
  const minor = async (user: { id: number; roles: string[] }) =>
    new Map(
      (
        (await queuePage.load({
          params: { slug: 'minor' },
          url: new URL('https://mod.test/images/minor'),
          locals: { user, grants: GRANTS },
        } as never)) as { items: Card[] }
      ).items.map((c) => [c.id, c])
    );
  const reported = async (user: { id: number; roles: string[] }) =>
    new Map(
      (
        (await (
          await reportsImagePage()
        ).load({
          url: new URL('https://mod.test/reports/image'),
          locals: { user, grants: GRANTS },
        } as never)) as { items: Card[] }
      ).items.map((c) => [c.id, c])
    );

  it.each([
    ['minor review', minor],
    ['reported', reported],
  ] as const)('%s draws a withheld card restricted, and the rest as before', async (_, read) => {
    const cards = await read(WITHOUT_GRANT);
    expect(cards.get(KEPT)).toMatchObject({ url: '', restricted: true });
    expect(cards.get(CLEAN)).toMatchObject({ url: 'queue-clean-key', restricted: false });
  });

  it.each([
    ['minor review', minor],
    ['reported', reported],
  ] as const)('%s sends a grant holder the withheld card with its media', async (_, read) => {
    expect((await read(WITH_GRANT)).get(KEPT)).toMatchObject({
      url: 'queue-key',
      restricted: false,
    });
  });

  // An automated review flag alone does not withhold a card.
  it.each([
    ['minor review', minor],
    ['reported', reported],
  ] as const)(
    '%s draws a card with only an automated review flag with its media',
    async (_, read) => {
      await db.exec(`INSERT INTO "ScanLabelItem" (id, "imageId") VALUES (990000090, ${CLEAN});
      INSERT INTO "ScanLabelFlag" ("itemId", snapshot) VALUES (990000090, '{"csam": "true"}')`);
      expect((await read(WITHOUT_GRANT)).get(CLEAN)).toMatchObject({
        url: 'queue-clean-key',
        restricted: false,
      });
    }
  );

  // The moderator-view rule reads Postgres only, and a scan flag is not a CSAM mark.
  it.each([
    ['minor review', minor],
    ['reported', reported],
  ] as const)(
    '%s shows a flagged card on a pulled post and refused url while the scanner cannot answer',
    async (_, read) => {
      await db.exec(`INSERT INTO "Post" (id, "userId", "publishedAt", metadata)
          VALUES (990000092, 9, NULL, '{"unpublishedAt": "2026-11-24T00:00:00Z", "unpublishedBy": "2"}');
        UPDATE "Image" SET "postId" = 990000092 WHERE id = ${CLEAN};
        INSERT INTO "ImageCdnAccess" (url, state) VALUES ('queue-clean-key', 'Denied');
        INSERT INTO "ScanLabelItem" (id, "imageId") VALUES (990000093, ${CLEAN});
        INSERT INTO "ScanLabelFlag" ("itemId", snapshot) VALUES (990000093, '{"csam": "true"}')`);
      scanner.down = true;
      expect((await read(WITHOUT_GRANT)).get(CLEAN)).toMatchObject({
        url: 'queue-clean-key',
        restricted: false,
      });
    }
  );

  it.each([
    ['minor review', minor],
    ['reported', reported],
  ] as const)('%s shows a card whose label item is on a csam hold', async (_, read) => {
    await db.exec(
      `INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES (990000091, ${CLEAN}, 'csam-hold')`
    );
    expect((await read(WITHOUT_GRANT)).get(CLEAN)).toMatchObject({
      url: 'queue-clean-key',
      restricted: false,
    });
  });

  it('sends no report reason or details on a withheld reported card, and both to a grant holder', async () => {
    expect((await reported(WITHOUT_GRANT)).get(KEPT)).toMatchObject({
      report: { reason: '', details: null },
    });
    expect((await reported(WITH_GRANT)).get(KEPT)).toMatchObject({
      report: { reason: 'TOSViolation', details: {} },
    });
  });

  it('withholds every card, rather than failing to load, when the read fails', async () => {
    await db.exec(`DROP TABLE "CsamReport"`);
    const cards = await minor(WITHOUT_GRANT);
    expect([...cards.values()].map((c) => c.restricted)).toEqual([true, true]);
  });

  // The grid leaves a restricted card out of the selection, so a bulk accept posts the rest.
  it('bulk accepts the rest of the page', async () => {
    await queuePage.actions.bulkAccept(event(WITHOUT_GRANT, { imageIds: String(CLEAN) }));
    expect(acceptImage).toHaveBeenCalledOnce();
  });
});
