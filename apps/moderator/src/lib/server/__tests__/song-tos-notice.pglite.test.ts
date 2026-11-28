import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The owner's ToS notice names what was removed (Music T10 item 2): a song as "Your song …", its
 * cover as "The cover of your song …", both linking to the song, since a cover has no post or page of
 * its own. An image's notice is as before. The wording itself is the main app's `tos-violation`
 * template (src/server/notifications/system.notifications.ts).
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, createNotification } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  createNotification: vi.fn(async (_n: unknown) => undefined),
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
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));
vi.mock('../redis', () => ({ getSysRedis: vi.fn(), getRedis: vi.fn() }));
vi.mock('../clickhouse', () => ({ getClickhouse: vi.fn() }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));

const { notifyImageTosViolation } = await import('../image-moderation-effects');

const OWNER = 7;
const SONG = 20;
const COVER = 120;
const UNTITLED_SONG = 21;
const UNTITLED_COVER = 121;
const PICTURE = 30;

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Image" (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT 'image', "userId" INTEGER NOT NULL,
      "postId" INTEGER, metadata JSONB
    );
    CREATE TABLE "Track" ("imageId" INTEGER PRIMARY KEY, "coverImageId" INTEGER UNIQUE);
    INSERT INTO "Image" (id, type, "userId", "postId", metadata) VALUES
      (${SONG}, 'audio', ${OWNER}, 5, '{"title": "Night drive"}'),
      (${COVER}, 'image', ${OWNER}, NULL, NULL),
      (${UNTITLED_SONG}, 'audio', ${OWNER}, 6, NULL),
      (${UNTITLED_COVER}, 'image', ${OWNER}, NULL, NULL),
      (${PICTURE}, 'image', ${OWNER}, 9, NULL);
    INSERT INTO "Track" ("imageId", "coverImageId") VALUES
      (${SONG}, ${COVER}), (${UNTITLED_SONG}, ${UNTITLED_COVER});
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

beforeEach(() => createNotification.mockClear());

const sentDetails = () =>
  (createNotification.mock.calls[0]?.[0] as { details: Record<string, unknown> } | undefined)
    ?.details;

describe('the ToS notice', () => {
  it('names a song as the song, linking to it', async () => {
    await notifyImageTosViolation({ imageId: SONG, ownerId: OWNER, postId: 5, reason: 'Gore' });
    expect(sentDetails()).toEqual({
      entity: 'song',
      modelName: 'Night drive',
      url: `/images/${SONG}`,
      reason: 'Gore',
    });
  });

  it("names a cover as the song's cover, linking to the song", async () => {
    await notifyImageTosViolation({ imageId: COVER, ownerId: OWNER, postId: null });
    expect(sentDetails()).toEqual({
      entity: 'song cover',
      modelName: 'Night drive',
      url: `/images/${SONG}`,
    });
  });

  it('leaves the title empty for an untitled song, so the wording drops it', async () => {
    await notifyImageTosViolation({ imageId: UNTITLED_COVER, ownerId: OWNER, postId: null });
    expect(sentDetails()).toEqual({
      entity: 'song cover',
      modelName: '',
      url: `/images/${UNTITLED_SONG}`,
    });
  });

  it("is an image's notice for an image, as before", async () => {
    await notifyImageTosViolation({ imageId: PICTURE, ownerId: OWNER, postId: 9, reason: 'Gore' });
    expect(sentDetails()).toEqual({
      entity: 'image',
      modelName: 'post #9',
      url: `/images/${PICTURE}`,
      reason: 'Gore',
    });
  });
});
