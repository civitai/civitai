import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * Image actions refuse a batch with an image the media access rule withholds from this moderator,
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
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { reportModerationActions } = await import('../report-actions');
const bulkPage = await import('../../../routes/retool/bulk-image-manager/+page.server');

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
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
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

    it('is refused without the grant', async () => {
      expect((await removeAll(WITHOUT_GRANT, 10, 'large')).status).toBe(403);
      expect(writes.removeAllImagesForUser).not.toHaveBeenCalled();
    });

    it('is removed for a grant holder', async () => {
      await removeAll(WITH_GRANT, 10, 'large');
      expect(writes.removeAllImagesForUser).toHaveBeenCalledOnce();
    });
  });

  it('removes the account with the withheld image for a grant holder', async () => {
    await removeAll(WITH_GRANT, 7, 'owner');
    expect(writes.removeAllImagesForUser).toHaveBeenCalledOnce();
  });
});
