import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../test/pglite-kysely';
import { votesOnDay } from './rail';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsPlayerDay"`);
});

describe('votesOnDay', () => {
  it("sums every player's votes for that day and no other", async () => {
    await pg.exec(`INSERT INTO "KnightsPlayerDay" ("playerId","day","votes") VALUES
      (1,'2026-12-15',30),(2,'2026-12-15',12),(1,'2026-12-14',99)`);
    expect(await votesOnDay(db, '2026-12-15')).toBe(42);
  });

  it('is 0 on a day nobody judged', async () => {
    expect(await votesOnDay(db, '2026-12-15')).toBe(0);
  });
});
