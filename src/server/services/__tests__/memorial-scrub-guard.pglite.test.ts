import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMORIALIZED_SCRUB_REFUSAL, memorialScrubGuardSql } from '~/server/services/user.service';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/** The account scrub's memorial guard, run on Postgres: a memorialized account fails the transaction. */

const LIVE = 990100501;
const MEMORIAL = 990100502;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, flags int NOT NULL DEFAULT 0);
    INSERT INTO "User" (id, flags) VALUES (${LIVE}, 0), (${MEMORIAL}, ${UserFlag.Memorialized});
  `);
});
afterAll(() => db.close());

describe('memorialScrubGuardSql', () => {
  it('passes an account that is not memorialized (control)', async () => {
    await expect(db.exec(memorialScrubGuardSql(LIVE).sql)).resolves.toBeDefined();
  });

  it('fails the statement for a memorialized account', async () => {
    await expect(db.exec(memorialScrubGuardSql(MEMORIAL).sql)).rejects.toThrow(
      MEMORIALIZED_SCRUB_REFUSAL
    );
  });

  it('refuses an id it cannot inline safely', () => {
    expect(() => memorialScrubGuardSql(-1)).toThrow();
    expect(() => memorialScrubGuardSql(1.5)).toThrow();
  });
});
