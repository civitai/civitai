import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  GENERATOR_EVIDENCE_HOLD_REASON,
  placeEvidenceHold,
  releaseEvidenceHold,
} from '@civitai/db-queries/evidence-hold';
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
const DAY_MS = 24 * 60 * 60 * 1000;
/** Midnight UTC, `days` from today: far enough out never to lapse while the suite runs. */
const daysOut = (days: number) => {
  const d = new Date(Date.now() + days * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

let pg: PGlite;
let db: Kysely<DB>;

const heldUntil = async (userId: number) =>
  db
    .selectFrom('EvidenceHeldUser')
    .select(sql<Date | null>`"heldUntil" AT TIME ZONE 'UTC'`.as('heldUntil'))
    .where('userId', '=', userId)
    .executeTakeFirst();

beforeAll(async () => {
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

  it('a hold that ran out by its date is not reused: placing again holds the owner anew', async () => {
    const LAPSED = 8;
    await pg.exec(`
      INSERT INTO "User" ("id", "username") VALUES (${LAPSED}, 'lapsed');
      INSERT INTO "EvidenceHold" ("userId", "role", "reason", "releaseAt")
        VALUES (${LAPSED}, 'manual', 'DMCA put-back', now() - interval '1 day');
    `);
    expect(await heldUntil(LAPSED)).toBeUndefined();

    const placed = await placeEvidenceHold(db, {
      userId: LAPSED,
      role: 'manual',
      reason: 'DMCA put-back',
      createdById: MOD,
    });
    expect(placed.created).toBe(true);
    expect(await heldUntil(LAPSED)).toEqual({ heldUntil: null });
  });

  it('an indefinite hold is not satisfied by a dated one with the same reason', async () => {
    const DATED = 10;
    await pg.exec(`
      INSERT INTO "User" ("id", "username") VALUES (${DATED}, 'dated');
      INSERT INTO "EvidenceHold" ("userId", "role", "reason", "releaseAt")
        VALUES (${DATED}, 'manual', '${GENERATOR_EVIDENCE_HOLD_REASON}', now() + interval '2 days');
    `);
    const placed = await placeEvidenceHold(db, {
      userId: DATED,
      role: 'manual',
      reason: GENERATOR_EVIDENCE_HOLD_REASON,
      createdById: MOD,
    });
    expect(placed.created).toBe(true);
    expect(await heldUntil(DATED)).toEqual({ heldUntil: null });
  });

  it('a dated request is met by a hold lasting at least as long, and not by a shorter one', async () => {
    const SHORT = 11;
    await pg.exec(`INSERT INTO "User" ("id", "username") VALUES (${SHORT}, 'short');`);
    const place = (releaseAt: Date) =>
      placeEvidenceHold(db, {
        userId: SHORT,
        role: 'manual',
        reason: 'dated twice',
        createdById: MOD,
        releaseAt,
      });
    const first = await place(daysOut(800));
    const earlier = await place(daysOut(400));
    const laterEnd = daysOut(1200);
    const later = await place(laterEnd);
    expect(earlier).toEqual({ id: first.id, created: false });
    expect(later.created).toBe(true);
    expect((await heldUntil(SHORT))?.heldUntil?.toISOString()).toBe(laterEnd.toISOString());
  });

  it('a hold past its date but extended is in force until the extension ends', async () => {
    const EXTENDED = 12;
    const extendedTo = daysOut(600);
    await pg.exec(`
      INSERT INTO "User" ("id", "username") VALUES (${EXTENDED}, 'extended');
      INSERT INTO "EvidenceHold"
        ("userId", "role", "reason", "releaseAt", "extendedUntil", "extensionRequestedBy", "extensionReference")
        VALUES (${EXTENDED}, 'manual', 'extended', now() - interval '1 day',
          '${extendedTo.toISOString().slice(0, 10)}', 'requester', 'ref-2');
    `);
    const id = (
      await db
        .selectFrom('EvidenceHold')
        .select('id')
        .where('userId', '=', EXTENDED)
        .executeTakeFirstOrThrow()
    ).id;
    const place = (releaseAt: Date | null) =>
      placeEvidenceHold(db, {
        userId: EXTENDED,
        role: 'manual',
        reason: 'extended',
        createdById: MOD,
        releaseAt,
      });
    expect(await place(daysOut(300))).toEqual({ id, created: false });
    expect((await place(daysOut(900))).created).toBe(true);
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

  it('stores the end date as UTC even from a session off UTC, and the view ends the hold there', async () => {
    const end = daysOut(500);
    await pg.exec(`SET TIME ZONE 'America/Chicago';`);
    await placeEvidenceHold(db, {
      userId: 2,
      role: 'manual',
      reason: 'dated',
      createdById: MOD,
      releaseAt: end,
    });
    await pg.exec(`SET TIME ZONE 'UTC';`);
    expect((await heldUntil(2))?.heldUntil?.toISOString()).toBe(end.toISOString());
  });
});

const keptImages = async (userId: number) =>
  Number(
    (
      await db
        .selectFrom('EvidenceHoldImage')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow()
    ).n
  );

describe('releaseEvidenceHold', () => {
  it('refuses a report hold: it stays open and nothing it kept is purged', async () => {
    const REPORTED = 6;
    await pg.exec(`
      INSERT INTO "User" ("id", "username") VALUES (${REPORTED}, 'reported');
      INSERT INTO "EvidenceHold" ("userId", "csamReportId", "role", "reason")
        VALUES (${REPORTED}, 990000001, 'subject', 'report sent');
      INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (990000011, ${REPORTED});
    `);
    const hold = await db
      .selectFrom('EvidenceHold')
      .select('id')
      .where('userId', '=', REPORTED)
      .executeTakeFirstOrThrow();

    expect(
      await releaseEvidenceHold(db, { id: hold.id, releasedById: MOD, releaseReason: 'early' })
    ).toBe(false);
    const row = await db
      .selectFrom('EvidenceHold')
      .select('releasedAt')
      .where('id', '=', hold.id)
      .executeTakeFirstOrThrow();
    expect(row.releasedAt).toBeNull();
    expect(await heldUntil(REPORTED)).toBeDefined();
    expect(await keptImages(REPORTED)).toBe(1);
  });

  it('refuses the generator-evidence hold: it stays open and nothing it kept is purged', async () => {
    const PENDING = 9;
    await pg.exec(`INSERT INTO "User" ("id", "username") VALUES (${PENDING}, 'pending');`);
    const { id } = await placeEvidenceHold(db, {
      userId: PENDING,
      role: 'manual',
      reason: GENERATOR_EVIDENCE_HOLD_REASON,
      createdById: MOD,
    });
    await pg.exec(
      `INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (990000013, ${PENDING});`
    );

    expect(await releaseEvidenceHold(db, { id, releasedById: MOD, releaseReason: 'early' })).toBe(
      false
    );
    expect(await heldUntil(PENDING)).toEqual({ heldUntil: null });
    expect(await keptImages(PENDING)).toBe(1);
  });

  it('refuses a manual hold while an outside extension is in force, and purges nothing', async () => {
    const KEPT_FOR = 13;
    await pg.exec(`
      INSERT INTO "User" ("id", "username") VALUES (${KEPT_FOR}, 'kept for');
      INSERT INTO "EvidenceHold"
        ("userId", "role", "reason", "releaseAt", "extendedUntil", "extensionRequestedBy", "extensionReference")
        VALUES (${KEPT_FOR}, 'manual', 'asked to keep', now() + interval '1 day',
          now() + interval '90 days', 'requester', 'ref-3');
      INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (990000014, ${KEPT_FOR});
    `);
    const { id } = await db
      .selectFrom('EvidenceHold')
      .select('id')
      .where('userId', '=', KEPT_FOR)
      .executeTakeFirstOrThrow();
    expect(await releaseEvidenceHold(db, { id, releasedById: MOD, releaseReason: 'early' })).toBe(
      false
    );
    expect(await heldUntil(KEPT_FOR)).toBeDefined();
    expect(await keptImages(KEPT_FOR)).toBe(1);
  });

  it('releasing a manual hold does purge what it kept (the control for the case above)', async () => {
    const MANUAL = 7;
    await pg.exec(`INSERT INTO "User" ("id", "username") VALUES (${MANUAL}, 'manual');`);
    const { id } = await placeEvidenceHold(db, {
      userId: MANUAL,
      role: 'manual',
      reason: 'kept',
      createdById: MOD,
    });
    await pg.exec(
      `INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (990000012, ${MANUAL});`
    );
    expect(await keptImages(MANUAL)).toBe(1);
    expect(await releaseEvidenceHold(db, { id, releasedById: MOD, releaseReason: 'done' })).toBe(
      true
    );
    expect(await keptImages(MANUAL)).toBe(0);
  });

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
    const releasedAt = await db
      .selectFrom('EvidenceHold')
      .select(sql<Date>`"releasedAt" AT TIME ZONE 'UTC'`.as('at'))
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(Math.abs(releasedAt.at.getTime() - Date.now())).toBeLessThan(60_000);
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
