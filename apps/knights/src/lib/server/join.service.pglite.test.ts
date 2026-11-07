import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../test/pglite-kysely';
import { seedPlayer } from '../../test/seed';
import { joinOrder } from './join.service';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(() => pg.exec(`TRUNCATE "NewOrderPlayer"`));

const players = async () =>
  (await pg.query<{ userId: number; rankType: string }>(`SELECT * FROM "NewOrderPlayer"`)).rows;

describe('joinOrder', () => {
  it('swears a new player in as an Acolyte', async () => {
    expect(await joinOrder(db, 7)).toEqual({ joined: true });
    expect(await players()).toMatchObject([{ userId: 7, rankType: 'Acolyte' }]);
  });

  it('is idempotent', async () => {
    await joinOrder(db, 7);
    expect(await joinOrder(db, 7)).toEqual({ joined: false });
    expect(await players()).toHaveLength(1);
  });

  it('leaves a player who already has a rank untouched', async () => {
    await seedPlayer(pg, 7, 'Templar');
    expect(await joinOrder(db, 7)).toEqual({ joined: false });
    expect(await players()).toMatchObject([{ userId: 7, rankType: 'Templar' }]);
  });
});
