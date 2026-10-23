import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Who flagged a minor-hash seed, on the real SQL. The moderation log is append-only, so a seed that was
 * flagged, lifted and flagged again carries one `setMinor` row per flag; the detail is one row naming
 * the latest.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

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
vi.mock('../cache', () => ({ createCache: () => ({ get: vi.fn(), bust: vi.fn() }) }));

const { getMinorHashMatchDetail } = await import('../minor-hash.service');

const MATCH = 1;
const SEED = 2;

const SCHEMA = `
CREATE TABLE "User" (id INTEGER PRIMARY KEY, username TEXT, "createdAt" TIMESTAMP(3) DEFAULT now());
CREATE TABLE "Model" (
  id INTEGER PRIMARY KEY, "userId" INTEGER, status TEXT NOT NULL DEFAULT 'Published',
  "createdAt" TIMESTAMP(3) DEFAULT now(), "deletedAt" TIMESTAMP(3), mode TEXT, meta JSONB DEFAULT '{}'
);
CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, "modelId" INTEGER);
CREATE TABLE "Post" (id INTEGER PRIMARY KEY, "modelVersionId" INTEGER);
CREATE TABLE "Image" (id INTEGER PRIMARY KEY, "postId" INTEGER, index INTEGER, url TEXT, type TEXT);
CREATE TABLE "ModActivity" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, activity TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
INSERT INTO "User" (id, username) VALUES (1, 'uploader'), (2, 'first-mod'), (3, 'latest-mod');
INSERT INTO "Model" (id, "userId") VALUES (${MATCH}, 1), (${SEED}, 1);
`;

const FLAGS = [
  [2, '2026-01-01T00:00:00Z'],
  [3, '2026-06-01T00:00:00Z'],
] as const;

let pg: PGlite;
let rowCount: number;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  const db = new Kysely({ dialect: pgliteDialect(pg) });
  // The service returns the first row, so how many the statement produced is only visible here.
  dbHandle.current = db.withPlugin({
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => {
      rowCount = result.rows.length;
      return result;
    },
  });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('getMinorHashMatchDetail on a seed flagged more than once', () => {
  // Both insertion orders: an unordered join happens to name the right moderator in one of them.
  it.each(['oldest first', 'latest first'] as const)(
    'returns one row naming the latest flag (%s)',
    async (order) => {
      for (const [userId, at] of order === 'oldest first' ? FLAGS : [...FLAGS].reverse())
        await pg.query(
          `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
           VALUES ($1, 'setMinor', 'model', $2, $3)`,
          [userId, SEED, at]
        );

      const detail = await getMinorHashMatchDetail({ modelId: MATCH, minorModelId: SEED });

      expect(rowCount).toBe(1);
      expect(detail?.minorFlaggedByUsername).toBe('latest-mod');
    }
  );
});
