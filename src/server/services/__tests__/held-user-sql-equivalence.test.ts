import { PGlite } from '@electric-sql/pglite';
import { heldUserSql } from '@civitai/shared/held-media';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as eventEngine from '../../../../apps/event-engine/src/vector-sync/held';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The oracle: heldUserSql's secondary-report leg as it read the id before it compared text (through
 * #8943's uncorrelated list, same results). A user a CsamReport names, as subject or secondary user,
 * stays held: the one difference allowed is a non-canonical id ("007"), which the app never writes.
 */
const heldUserSqlBefore = (user: string) => `(
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = ${user})
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE CASE WHEN hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
                   THEN (hs.details ->> 'secondaryUserId')::bigint END = ${user}
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = ${user})
    )`;

const SUBJECT = 1;
const SECONDARY = 2;
const BOTH = 3;
const NEITHER = 4;
const HOLD_ONLY = 6;
const NONCANONICAL = 7;
// Ids a malformed secondaryUserId could be misread as.
const NEGATIVE = -5;
// The 21-digit value's first 18 digits; past 2^53, so kept as text.
const OVERFLOW_PREFIX = '123456789012345678';

const pg = new PGlite();

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "Viewer" (id bigint);
    INSERT INTO "Viewer" VALUES (${SUBJECT}), (${SECONDARY}), (${BOTH}), (${NEITHER}),
      (${HOLD_ONLY}), (${NONCANONICAL}), (${NEGATIVE}), (${OVERFLOW_PREFIX}), (NULL);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}');
    INSERT INTO "CsamReport" ("userId", details) VALUES
      (${SUBJECT}, '{}'),
      (NULL, '{"secondaryUserId": "${SECONDARY}"}'),
      (${BOTH}, '{"secondaryUserId": "${BOTH}"}'),
      (NULL, '{"secondaryUserId": "abc"}'),
      (NULL, '{"secondaryUserId": "123456789012345678901"}'),
      (NULL, '{"secondaryUserId": ""}'),
      (NULL, '{"secondaryUserId": "${NEGATIVE}"}'),
      (NULL, '{"secondaryUserId": null}'),
      (NULL, '{"secondaryUserId": "00${NONCANONICAL}"}');
    CREATE TABLE "EvidenceHeldUser" ("userId" int);
    INSERT INTO "EvidenceHeldUser" VALUES (${HOLD_ONLY});
  `);
});

afterAll(async () => {
  await pg.close();
});

const held = async (sql: (user: string) => string) =>
  (
    await pg.query<{ id: string | number | bigint | null; held: boolean | null }>(
      `SELECT id, ${sql('v."id"')} AS held FROM "Viewer" v ORDER BY id NULLS LAST`
    )
  ).rows.map((r) => [r.id === null ? null : String(r.id), r.held]);

describe('heldUserSql', () => {
  it('holds the users the oracle held, NULL and malformed reports included, except a non-canonical id', async () => {
    const before = await held(heldUserSqlBefore);
    expect(await held(heldUserSql)).toEqual(
      before.map(([id, isHeld]) => [id, id === String(NONCANONICAL) ? false : isHeld])
    );
    expect(before).toEqual([
      [String(NEGATIVE), false],
      [String(SUBJECT), true],
      [String(SECONDARY), true],
      [String(BOTH), true],
      [String(NEITHER), false],
      [String(HOLD_ONLY), true],
      [String(NONCANONICAL), true],
      [OVERFLOW_PREFIX, false],
      [null, false],
    ]);
  });

  it("is the event-engine copy's result too", async () => {
    expect(await held(eventEngine.heldUserSql)).toEqual(await held(heldUserSql));
  });
});
