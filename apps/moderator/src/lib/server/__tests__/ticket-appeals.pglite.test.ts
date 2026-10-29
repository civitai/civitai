import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const h = vi.hoisted(() => ({ db: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!h.db.current) throw new Error('the pglite client was not installed for this test');
    return h.db.current;
  },
  get dbWrite() {
    if (!h.db.current) throw new Error('the pglite client was not installed for this test');
    return h.db.current;
  },
}));

const { appealsSectionFor } = await import('../tickets/appeals');

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(`
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "userId" integer NOT NULL,
      "entityType" text NOT NULL,
      "entityId" integer NOT NULL,
      status text NOT NULL,
      "createdAt" timestamp(3) NOT NULL,
      "resolvedAt" timestamp(3),
      "resolvedReason" text,
      "resolvedMessage" text,
      "entityRemovedAt" timestamp(3),
      category text
    );
  `);
  h.db.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  await (h.db.current as Kysely<unknown>).destroy();
  h.db.current = null;
});

const now = new Date('2026-10-29T00:00:00Z');

describe('appealsSectionFor against Postgres', () => {
  it('keeps an old pending appeal when the window holds more appeals than one read', async () => {
    await pg.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, "createdAt")
       VALUES (7, 'Image', 1, 'Pending', '2026-01-01')`
    );
    await pg.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, "createdAt", "resolvedAt")
       SELECT 7, 'Image', 1000 + g, 'Rejected', '2026-10-20'::timestamp + g * interval '1 minute', '2026-10-21'
       FROM generate_series(1, 150) g`
    );
    const res = await appealsSectionFor({ userId: 7, text: '', canRead: () => true, now });
    expect(res.appeals[0]).toMatchObject({ entityId: 1, status: 'Pending' });
    expect(res.truncated).toBe(true);
  });

  it('lists pending appeals before decided ones, each newest first', async () => {
    await pg.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, "createdAt", "resolvedAt") VALUES
       (7, 'Image', 1, 'Pending',  '2026-10-01', NULL),
       (7, 'Image', 2, 'Rejected', '2026-10-25', '2026-10-26'),
       (7, 'Image', 3, 'Pending',  '2026-10-10', NULL),
       (8, 'Image', 4, 'Pending',  '2026-10-28', NULL)`
    );
    const res = await appealsSectionFor({ userId: 7, text: '', canRead: () => true, now });
    expect(res.appeals.map((a) => a.entityId)).toEqual([3, 1, 2]);
    expect(res.truncated).toBe(false);
  });
});
