import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

process.env.TZ = 'America/New_York';

const { createQueueDb } = await import('../../../test/pglite-kysely');
const { castVote, enqueueItem, escalateExpired } = await import('./queue.service');

const NOW = new Date('2026-12-15T12:00:00Z');
let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});

describe('on a host that is not on UTC', () => {
  it('runs in a non-UTC zone', () => {
    expect(new Date(NOW).getTimezoneOffset()).not.toBe(0);
  });

  it('stores and compares every timestamp as a UTC instant', async () => {
    await pg.exec(`INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES (1,'Knight');
      INSERT INTO "Image" ("id","url") VALUES (10,'key-10')`);
    const id = await enqueueItem(
      db,
      { questionKey: 'knights.image.nsfwLevel', imageId: 10, source: 'test' },
      NOW
    );
    await castVote(
      db,
      { userId: 1, itemId: id, answer: '4' },
      { applyConsensus: async () => undefined, now: () => NOW }
    );

    const stored = await pg.query<{ voted: string; expires: string }>(
      `SELECT to_char(v."createdAt",'YYYY-MM-DD HH24:MI') AS voted,
              to_char(i."expiresAt",'YYYY-MM-DD HH24:MI') AS expires
       FROM "KnightsVote" v JOIN "KnightsQueueItem" i ON i.id = v."itemId"`
    );
    expect(stored.rows[0]).toEqual({ voted: '2026-12-15 12:00', expires: '2026-12-18 12:00' });

    const justBefore = new Date('2026-12-18T11:59:00Z');
    expect(await escalateExpired(db, { now: justBefore })).toEqual({
      escalated: 0,
      toInquisitor: 0,
    });
    const atExpiry = new Date('2026-12-18T12:00:00Z');
    expect(await escalateExpired(db, { now: atExpiry })).toEqual({ escalated: 1, toInquisitor: 0 });
  });
});
