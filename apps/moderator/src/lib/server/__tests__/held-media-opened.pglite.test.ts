import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HeldMediaModule from '../held-media';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * `POST /api/held-media/[imageId]/opened`: the full view's row for an image it put on screen. The row
 * goes through the real `recordModActivity` into a Postgres stand-in, so who and when are what the
 * database recorded.
 */

const { dbHandle, getHeldMedia, grants } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  getHeldMedia: vi.fn(),
  grants: { paths: new Set<string>(['/images/csam']) },
}));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('$lib/server/access', async () => {
  const { error } = await import('@sveltejs/kit');
  const canAccess = (_user: unknown, path: string) => grants.paths.has(path);
  return {
    canAccess,
    requireAccess: (user: unknown, path: string) => {
      if (!canAccess(user, path)) error(403, 'no');
    },
  };
});
vi.mock('$lib/server/held-media', async (importOriginal) => ({
  ...(await importOriginal<typeof HeldMediaModule>()),
  getHeldMedia,
}));

const { POST } = await import('../../../routes/api/held-media/[imageId]/opened/+server');

let db: PGlite;

const rows = async () =>
  (
    await db.query<{
      userId: number;
      activity: string;
      entityType: string;
      entityId: number;
      createdAt: Date;
    }>(`SELECT "userId", activity, "entityType", "entityId", "createdAt" FROM "ModActivity"`)
  ).rows;

async function post(imageId: string, body?: string) {
  const url = new URL(`http://mod.test/api/held-media/${imageId}/opened`);
  try {
    const res = await POST({
      params: { imageId },
      url,
      request: new Request(url, { method: 'POST', body }),
      locals: { user: { id: 42, roles: ['moderator:staff'] }, grants: {} },
    } as never);
    return res.status;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "activity" TEXT NOT NULL,
      "entityType" TEXT,
      "entityId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  await db.exec(`DELETE FROM "ModActivity"`);
  grants.paths = new Set(['/images/csam']);
  getHeldMedia.mockReset().mockResolvedValue({ url: 'key', type: 'image', mimeType: null });
});

describe('POST /api/held-media/[imageId]/opened', () => {
  it('records the open against the session moderator, at database time', async () => {
    const [{ now: before }] = (await db.query<{ now: Date }>(`SELECT LOCALTIMESTAMP AS now`)).rows;

    expect(await post('7')).toBe(204);

    const [{ now: after }] = (await db.query<{ now: Date }>(`SELECT LOCALTIMESTAMP AS now`)).rows;
    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      userId: 42,
      activity: 'reportMedia:open:original',
      entityType: 'image',
      entityId: 7,
    });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('refuses a moderator without the CSAM page, and writes nothing', async () => {
    grants.paths = new Set();
    expect(await post('7')).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it('refuses an image the full view cannot show, and writes nothing', async () => {
    getHeldMedia.mockResolvedValue(null);
    expect(await post('7')).toBe(404);
    expect(getHeldMedia).toHaveBeenCalledWith(7);
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['a moderator', JSON.stringify({ userId: 7 })],
    ['a time', JSON.stringify({ createdAt: '2020-01-01T00:00:00Z' })],
    ['anything', 'x'],
  ])('refuses a body naming %s, and writes nothing', async (_, body) => {
    expect(await post('7', body)).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('refuses a bad image id, and writes nothing', async () => {
    expect(await post('x')).toBe(400);
    expect(await rows()).toEqual([]);
  });
});
