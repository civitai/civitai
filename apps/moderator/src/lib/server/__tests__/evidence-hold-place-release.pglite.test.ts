import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { placeEvidenceHold, releaseEvidenceHold } from '@civitai/db-queries/evidence-hold';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Placing and releasing a hold against the real hold migration, its guard trigger and its view. */

const HOLD_MIGRATION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
  ),
  'utf-8'
);

const MOD = 99;
const hostTz = process.env.TZ;

let pg: PGlite;
let db: Kysely<DB>;

const heldUntil = async (userId: number) =>
  db
    .selectFrom('EvidenceHeldUser')
    .select(sql<Date | null>`"heldUntil" AT TIME ZONE 'UTC'`.as('heldUntil'))
    .where('userId', '=', userId)
    .executeTakeFirst();

beforeAll(async () => {
  // Off UTC, a dropped `AT TIME ZONE 'UTC'` reads hours out.
  process.env.TZ = 'America/Chicago';
  pg = await freshPglite();
  await pg.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "userId" INTEGER, "postId" INTEGER, "metadata" JSONB);
    CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
    CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
    CREATE TABLE "CsamReport" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "reportSentAt" TIMESTAMP(3), "details" JSONB);
  `);
  await pg.exec(HOLD_MIGRATION);
  await pg.exec(
    `INSERT INTO "User" ("id", "username") SELECT g, 'user' || g FROM generate_series(1, 5) g;`
  );
  db = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});

afterAll(async () => {
  process.env.TZ = hostTz;
  await db?.destroy();
});

describe('placeEvidenceHold', () => {
  it('holds the owner until released, and a repeat returns the same open hold', async () => {
    const first = await placeEvidenceHold(db, {
      userId: 1,
      role: 'manual',
      reason: 'DMCA put-back',
      createdById: MOD,
    });
    const again = await placeEvidenceHold(db, {
      userId: 1,
      role: 'manual',
      reason: 'DMCA put-back',
      createdById: MOD,
    });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect(await heldUntil(1)).toEqual({ heldUntil: null });
  });

  it('a different reason is a separate hold', async () => {
    const other = await placeEvidenceHold(db, {
      userId: 1,
      role: 'manual',
      reason: 'another matter',
      createdById: MOD,
    });
    expect(other.created).toBe(true);
  });

  it('stores the end date as UTC, and the view ends the hold there', async () => {
    const end = new Date('2030-01-15T00:00:00Z');
    await placeEvidenceHold(db, {
      userId: 2,
      role: 'manual',
      reason: 'dated',
      createdById: MOD,
      releaseAt: end,
    });
    expect((await heldUntil(2))?.heldUntil?.toISOString()).toBe(end.toISOString());
  });
});

describe('releaseEvidenceHold', () => {
  it('records who released it and why, and the owner is no longer held', async () => {
    const { id } = await placeEvidenceHold(db, {
      userId: 3,
      role: 'manual',
      reason: 'to release',
      createdById: MOD,
    });
    expect(await heldUntil(3)).toBeDefined();

    expect(
      await releaseEvidenceHold(db, { id, releasedById: MOD, releaseReason: 'restored' })
    ).toBe(true);
    const row = await db
      .selectFrom('EvidenceHold')
      .select(['releasedAt', 'releasedById', 'releaseReason'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.releasedAt).not.toBeNull();
    expect(row).toMatchObject({ releasedById: MOD, releaseReason: 'restored' });
    expect(await heldUntil(3)).toBeUndefined();
  });

  it('a second release, or an unknown id, changes nothing and says so', async () => {
    const { id } = await placeEvidenceHold(db, {
      userId: 4,
      role: 'manual',
      reason: 'twice',
      createdById: MOD,
    });
    expect(await releaseEvidenceHold(db, { id, releasedById: MOD, releaseReason: 'first' })).toBe(
      true
    );
    expect(await releaseEvidenceHold(db, { id, releasedById: 1, releaseReason: 'second' })).toBe(
      false
    );
    expect(
      await releaseEvidenceHold(db, { id: 990000123, releasedById: MOD, releaseReason: 'none' })
    ).toBe(false);
    const row = await db
      .selectFrom('EvidenceHold')
      .select(['releasedById', 'releaseReason'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ releasedById: MOD, releaseReason: 'first' });
  });

  it('after a release, placing again opens a new hold rather than reusing the released one', async () => {
    const { id } = await placeEvidenceHold(db, {
      userId: 5,
      role: 'manual',
      reason: 'reopen',
      createdById: MOD,
    });
    await releaseEvidenceHold(db, { id, releasedById: MOD, releaseReason: 'done' });
    const next = await placeEvidenceHold(db, {
      userId: 5,
      role: 'manual',
      reason: 'reopen',
      createdById: MOD,
    });
    expect(next.created).toBe(true);
    expect(next.id).not.toBe(id);
  });
});
