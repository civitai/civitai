import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => dbHandle.current }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { getSweep } = await import('../front-page-audit.service');

const SCHEMA = `${IMAGE_PAGES_SCHEMA}
ALTER TABLE "Image" ADD COLUMN "aiNsfwLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tag" ADD COLUMN type TEXT;
`;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner');
    INSERT INTO "Image" (id, url, type, ingestion, "nsfwLevel", "aiNsfwLevel", "userId") VALUES
      (1, 'never-rated', 'image', 'Scanned', 4, 0, 7),
      (2, 'rated', 'image', 'Scanned', 4, 16, 7);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  await (dbHandle.current as Kysely<unknown>).destroy();
  dbHandle.current = null;
});

describe('front-page audit sweep, the AI rating', () => {
  it('sends no AI rating for an image whose aiNsfwLevel is the unwritten 0, and the value otherwise', async () => {
    const sweep = await getSweep({
      nsfwLevels: [4],
      order: 'newest',
      media: 'image',
      since: new Date(0),
    });
    expect(Object.fromEntries(sweep.map((i) => [i.id, i.aiNsfwLevel]))).toEqual({ 1: null, 2: 16 });
  });
});
