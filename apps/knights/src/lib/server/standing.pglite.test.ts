import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../test/pglite-kysely';
import { getStanding } from './standing';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(() => pg.exec(`TRUNCATE "User"`));

describe('getStanding', () => {
  it('finds an ordinary user in good standing', async () => {
    await pg.exec(`INSERT INTO "User" ("id") VALUES (1)`);
    expect(await getStanding(db, 1)).toEqual({ banned: false, muted: false });
  });

  it('reads a ban', async () => {
    await pg.exec(`INSERT INTO "User" ("id","bannedAt") VALUES (1,'2026-12-01')`);
    expect(await getStanding(db, 1)).toEqual({ banned: true, muted: false });
  });

  it('treats a deleted account like a banned one', async () => {
    await pg.exec(`INSERT INTO "User" ("id","deletedAt") VALUES (1,'2026-12-01')`);
    expect(await getStanding(db, 1)).toEqual({ banned: true, muted: false });
  });

  it('reads a mute without calling the user banned', async () => {
    await pg.exec(`INSERT INTO "User" ("id","muted") VALUES (1,true)`);
    expect(await getStanding(db, 1)).toEqual({ banned: false, muted: true });
  });

  it('reads both together and only for the asked user', async () => {
    await pg.exec(
      `INSERT INTO "User" ("id","muted","bannedAt") VALUES (1,true,'2026-12-01'), (2,false,NULL)`
    );
    expect(await getStanding(db, 1)).toEqual({ banned: true, muted: true });
    expect(await getStanding(db, 2)).toEqual({ banned: false, muted: false });
  });

  it('shuts out a user with no row', async () => {
    expect((await getStanding(db, 99)).banned).toBe(true);
  });
});
