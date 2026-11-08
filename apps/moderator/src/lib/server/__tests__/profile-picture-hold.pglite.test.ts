import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { handles } = vi.hoisted(() => ({
  handles: { read: null as unknown, write: null as unknown },
}));

vi.mock('../db', () => ({
  get dbRead() {
    return handles.read;
  },
  get dbWrite() {
    return handles.write;
  },
}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));

const { getProfilePictures } = await import('../user-lookup.service');
const { withHeldProfilePictures } = await import('../profile-picture-hold');
const { profilePictureUserIds } = await import('../profile-picture-cache');

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'image',
      "nsfwLevel" INTEGER NOT NULL DEFAULT 1, "minor" BOOLEAN NOT NULL DEFAULT false,
      "acceptableMinor" BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "profilePictureId" INTEGER);
    CREATE TABLE "ProfilePictureHold" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL,
      "imageId" INTEGER NOT NULL UNIQUE, "reason" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now());
    INSERT INTO "Image" ("id", "url", "nsfwLevel") VALUES
      (1, 'live', 1), (2, 'removed-old', 2), (3, 'removed-new', 4), (4, 'plain', 1);
    INSERT INTO "User" VALUES (10, 1), (11, NULL), (12, NULL);
    INSERT INTO "ProfilePictureHold" ("userId", "imageId", "reason", "createdAt") VALUES
      (11, 2, 'blocked', now() - interval '2 days'),
      (11, 3, 'flagged', now() - interval '1 day');
  `);
  handles.write = new Kysely({ dialect: pgliteDialect(db) });
  // The replica role has no grant on the table: model that, so a read of it on dbRead fails here too.
  const replica = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'query') return Reflect.get(target, prop, receiver);
      return (sql: string, params?: unknown[]) => {
        if (sql.includes('ProfilePictureHold'))
          return Promise.reject(new Error('permission denied for table ProfilePictureHold'));
        return target.query(sql, params);
      };
    },
  });
  handles.read = new Kysely({ dialect: pgliteDialect(replica) });
});

describe('removed profile pictures, read on the write connection', () => {
  it("shows a user's newest removed avatar where they have no live one", async () => {
    const pictures = await getProfilePictures([10, 11, 12]);
    expect(pictures.get(10)?.url).toBe('live');
    expect(pictures.get(11)).toMatchObject({ id: 3, url: 'removed-new', nsfwLevel: 4 });
    expect(pictures.has(12)).toBe(false);
  });

  it('shows none when the newest removed avatar has been purged, not an older one', async () => {
    await db.exec(`DELETE FROM "Image" WHERE id = 3`);
    const pictures = await getProfilePictures([11]);
    expect(pictures.has(11)).toBe(false);
  });

  it('badges a removed avatar as a profile picture in the moderator grids', async () => {
    const rows = await withHeldProfilePictures([
      { id: 1, isProfilePicture: true },
      { id: 2, isProfilePicture: false },
      { id: 4, isProfilePicture: false },
    ]);
    expect(rows.map((r) => r.isProfilePicture)).toEqual([true, true, false]);
  });

  it('busts the cache of the user a removed avatar belonged to', async () => {
    expect((await profilePictureUserIds([1, 3])).sort()).toEqual([10, 11]);
  });

  it('the replica stand-in does refuse the table', async () => {
    await expect(
      (handles.read as Kysely<{ ProfilePictureHold: { id: number } }>)
        .selectFrom('ProfilePictureHold')
        .select('id')
        .execute()
    ).rejects.toThrow('permission denied');
  });
});
