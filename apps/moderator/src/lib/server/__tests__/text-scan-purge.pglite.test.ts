import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { PURGE_BATCH, purgeDeletedSources } from '../text-scan-lab/purge.service';

/**
 * The purge over the REAL `text-scan-lab/schema.sql` on one PGlite and a hand-written slice of the
 * main database's tables on another: which rows it wipes is decided by joins and NULLs, which only a
 * real Postgres evaluates.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../text-scan-lab/schema.sql'), 'utf8');

// Only the columns the purge reads, named as in schema.full.prisma.
const MAIN_SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp);
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL, "deletedAt" timestamp);
  CREATE TABLE "Article" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "Challenge" (id int PRIMARY KEY, "createdById" int);
  CREATE TABLE "ChatMessage" (id int PRIMARY KEY, "userId" int NOT NULL, "deletedAt" timestamp);
  CREATE TABLE "UserProfile" ("userId" int PRIMARY KEY);
`;

let modPg: PGlite;
let mainPg: PGlite;
let dbs: { moderator: Kysely<ModeratorDB>; main: Kysely<MainDB> };
let setId: number;

beforeEach(async () => {
  modPg = await PGlite.create();
  mainPg = await PGlite.create();
  await modPg.exec(SCHEMA);
  await mainPg.exec(MAIN_SCHEMA);
  dbs = {
    moderator: new Kysely<ModeratorDB>({ dialect: pgliteDialect(modPg) }),
    main: new Kysely<MainDB>({ dialect: pgliteDialect(mainPg) }),
  };
  setId = await newSet('calibration');
});

async function newSet(name: string) {
  const { rows } = await modPg.query<{ id: string }>(
    `INSERT INTO text_scan_test_set (name, created_by) VALUES ($1, 1) RETURNING id`,
    [name]
  );
  return Number(rows[0].id);
}

async function addCase(
  entityType: string,
  entityId: number | null,
  {
    set = setId,
    synthetic = false,
    expected = { scam: true } as Record<string, unknown>,
    note = 'kept',
  } = {}
) {
  const { rows } = await modPg.query<{ id: string }>(
    `INSERT INTO text_scan_test_case
       (set_id, entity_type, entity_id, fields, text_hash, expected, synthetic, note, added_by)
     VALUES ($1, $2, $3, $4, 'hash', $5, $6, $7, 1) RETURNING id`,
    [
      set,
      entityType,
      entityId,
      JSON.stringify([{ heading: 'Name', text: 'FAKE TEXT' }]),
      JSON.stringify(expected),
      synthetic,
      note,
    ]
  );
  return Number(rows[0].id);
}

const caseRow = async (id: number) =>
  (
    await modPg.query<{
      fields: unknown;
      source_deleted_at: Date | null;
      expected: unknown;
      text_hash: string;
      note: string | null;
    }>(
      `SELECT fields, source_deleted_at, expected, text_hash, note FROM text_scan_test_case WHERE id = $1`,
      [id]
    )
  ).rows[0];

const wipedIds = async () =>
  (
    await modPg.query<{ id: string }>(
      `SELECT id FROM text_scan_test_case WHERE fields IS NULL ORDER BY id`
    )
  ).rows.map((r) => Number(r.id));

describe('purgeDeletedSources', () => {
  it('wipes a case whose entity row is gone, keeping its expectation, hash and note', async () => {
    const missing = await addCase('Model', 404, { expected: { nsfw: { min: 'r', max: 'x' } } });
    expect(await purgeDeletedSources(dbs)).toEqual({ checked: 1, wiped: 1 });
    const row = await caseRow(missing);
    expect(row.fields).toBeNull();
    expect(row.source_deleted_at).not.toBeNull();
    expect(row).toMatchObject({
      expected: { nsfw: { min: 'r', max: 'x' } },
      text_hash: 'hash',
      note: 'kept',
    });
  });

  it("wipes a soft-deleted entity and one whose author's account is deleted; keeps live ones", async () => {
    await mainPg.exec(`
      INSERT INTO "User" VALUES (1, NULL), (2, now());
      INSERT INTO "Model" VALUES (10, 1, NULL), (11, 1, now()), (12, 2, NULL);
      INSERT INTO "Article" VALUES (20, 1), (21, 2);
    `);
    const live = await addCase('Model', 10);
    const softDeleted = await addCase('Model', 11);
    const authorGone = await addCase('Model', 12);
    const liveArticle = await addCase('Article', 20);
    const articleAuthorGone = await addCase('Article', 21);
    expect(await purgeDeletedSources(dbs)).toEqual({ checked: 5, wiped: 3 });
    expect(await wipedIds()).toEqual([softDeleted, authorGone, articleAuthorGone]);
    expect((await caseRow(live)).fields).not.toBeNull();
    expect((await caseRow(liveArticle)).fields).not.toBeNull();
  });

  it('checks a User by its own row, a UserProfile by userId, and never deems a null or system author deleted', async () => {
    await mainPg.exec(`
      INSERT INTO "User" VALUES (1, NULL), (2, now());
      INSERT INTO "UserProfile" VALUES (1), (2);
      INSERT INTO "Challenge" VALUES (30, NULL);
      INSERT INTO "ChatMessage" VALUES (40, -1, NULL), (41, 1, now());
    `);
    const liveUser = await addCase('User', 1);
    const deletedUser = await addCase('User', 2);
    const liveProfile = await addCase('UserProfile', 1);
    const deletedProfile = await addCase('UserProfile', 2);
    const systemChallenge = await addCase('Challenge', 30);
    const systemMessage = await addCase('ChatMessage', 40);
    const deletedMessage = await addCase('ChatMessage', 41);
    await purgeDeletedSources(dbs);
    expect(await wipedIds()).toEqual([deletedUser, deletedProfile, deletedMessage]);
    for (const id of [liveUser, liveProfile, systemChallenge, systemMessage])
      expect((await caseRow(id)).fields).not.toBeNull();
  });

  it('never touches free text or synthetic cases', async () => {
    const freeText = await addCase('Model', null);
    const synthetic = await addCase('Model', 404, { synthetic: true });
    expect(await purgeDeletedSources(dbs)).toEqual({ checked: 0, wiped: 0 });
    expect((await caseRow(freeText)).fields).not.toBeNull();
    expect((await caseRow(synthetic)).fields).not.toBeNull();
  });

  it('is idempotent: a second run checks nothing already wiped and wipes nothing', async () => {
    const missing = await addCase('Model', 404);
    await purgeDeletedSources(dbs);
    const { source_deleted_at: first } = await caseRow(missing);
    expect(await purgeDeletedSources(dbs)).toEqual({ checked: 0, wiped: 0 });
    expect((await caseRow(missing)).source_deleted_at).toEqual(first);
  });

  it('limits itself to one set when given one', async () => {
    const other = await newSet('other');
    const here = await addCase('Model', 404);
    const there = await addCase('Model', 404, { set: other });
    expect(await purgeDeletedSources(dbs, setId)).toEqual({ checked: 1, wiped: 1 });
    expect(await wipedIds()).toEqual([here]);
    expect((await caseRow(there)).fields).not.toBeNull();
  });

  it('looks ids up in batches and finds the gone ones in every batch', async () => {
    const n = PURGE_BATCH * 2 + 1;
    await mainPg.exec(`
      INSERT INTO "User" VALUES (1, NULL);
      INSERT INTO "Model" SELECT g, 1, NULL FROM generate_series(1, ${n}) g
        WHERE g NOT IN (1, ${PURGE_BATCH + 1}, ${n});
    `);
    await modPg.exec(`
      INSERT INTO text_scan_test_case (set_id, entity_type, entity_id, fields, text_hash, added_by)
      SELECT ${setId}, 'Model', g, '[{"heading":"Name","text":"FAKE"}]', 'h', 1
      FROM generate_series(1, ${n}) g;
    `);
    const queries: string[] = [];
    const main = new Kysely<MainDB>({
      dialect: pgliteDialect(mainPg),
      log: (e) => {
        queries.push(e.query.sql);
      },
    });
    expect(await purgeDeletedSources({ ...dbs, main }, setId)).toEqual({ checked: n, wiped: 3 });
    expect(queries).toHaveLength(3);
    const wiped = await modPg.query<{ entity_id: number }>(
      `SELECT entity_id FROM text_scan_test_case WHERE fields IS NULL ORDER BY entity_id`
    );
    expect(wiped.rows.map((r) => r.entity_id)).toEqual([1, PURGE_BATCH + 1, n]);
  });
});
