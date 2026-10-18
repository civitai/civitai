import type { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  applyListingMediaSplitDecision,
  MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE,
  MEDIA_SPLIT_UNAVAILABLE_MESSAGE,
  readListingMediaSplit,
} from '~/server/services/blocks/listing-media-split.service';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * The split service against the REAL migration, and against a database where it has not been
 * applied yet — the state every environment is in until a human runs it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const LISTING = 'apl_split_a';
const OTHER = 'apl_split_b';
const MOD = 701;
const ICON = 11;
const COVER = 12;
const R_ICON = 13;

const face = { iconId: ICON, coverId: COVER };

describe('with the table ABSENT (migration not applied)', () => {
  let s: SplitDb;
  beforeAll(async () => {
    s = await createSplitDb();
    await s.seed({
      listingIds: [LISTING],
      images: { [ICON]: NsfwLevel.PG, [COVER]: NsfwLevel.PG },
      users: [MOD],
    });
  });
  afterAll(() => s.db.close());

  it('reads every listing as unsplit', async () => {
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(false);
  });

  it('an omitted or rate-mature decision is a no-op that reports unsplit', async () => {
    for (const decision of [undefined, 'rate-mature'] as const)
      expect(
        await applyListingMediaSplitDecision(s.raw, {
          appListingId: LISTING,
          face,
          decision,
          actorUserId: MOD,
        })
      ).toBe(false);
  });

  it('refuses an explicit split, saying it is not available yet', async () => {
    await expect(
      applyListingMediaSplitDecision(s.raw, {
        appListingId: LISTING,
        face,
        decision: 'split',
        actorUserId: MOD,
      })
    ).rejects.toThrow(MEDIA_SPLIT_UNAVAILABLE_MESSAGE);
  });

  it('🔴 never aborts the transaction it runs in', async () => {
    // Postgres aborts a transaction on ANY failed statement, caught or not. The approve paths
    // call these inside theirs, so a statement after them must still run.
    const after = await s.db.transaction(async (tx) => {
      const txRaw = createTxRaw(tx);
      await readListingMediaSplit(txRaw, LISTING);
      await applyListingMediaSplitDecision(txRaw, {
        appListingId: LISTING,
        face,
        decision: 'rate-mature',
        actorUserId: MOD,
      });
      return (await tx.query<{ n: number }>(`SELECT 41 + 1 AS n`)).rows[0].n;
    });
    expect(after).toBe(42);
  });
});

describe('with the migration applied', () => {
  let s: SplitDb;
  beforeAll(async () => {
    s = await createSplitDb();
    await s.applyMigration();
  });
  afterAll(() => s.db.close());
  beforeEach(async () => {
    await s.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
    await s.seed({
      listingIds: [LISTING, OTHER],
      images: { [ICON]: NsfwLevel.PG, [COVER]: NsfwLevel.PG13, [R_ICON]: NsfwLevel.R },
      users: [MOD],
    });
  });

  const grant = (appListingId = LISTING, f = face) =>
    applyListingMediaSplitDecision(s.raw, {
      appListingId,
      face: f,
      decision: 'split',
      actorUserId: MOD,
    });

  it('a split stamps the decision with its actor, and reads back as split for that listing only', async () => {
    expect(await grant()).toBe(true);
    expect(await s.stamp(LISTING)).toEqual({ at: expect.any(String), by: MOD });
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(true);
    expect(await readListingMediaSplit(s.raw, OTHER)).toBe(false);
  });

  it('a later rate-mature, or an omitted decision, clears it (default-closed)', async () => {
    for (const decision of ['rate-mature', undefined] as const) {
      await grant();
      expect(
        await applyListingMediaSplitDecision(s.raw, {
          appListingId: LISTING,
          face,
          decision,
          actorUserId: MOD,
        })
      ).toBe(false);
      expect(await s.stamp(LISTING)).toEqual({ at: null, by: null });
      expect(await readListingMediaSplit(s.raw, LISTING)).toBe(false);
    }
  });

  it('re-granting is an update of the one row, not a second row', async () => {
    await grant();
    await grant();
    const { rows } = await s.db.query(`SELECT count(*)::int AS n FROM app_listing_red_media`);
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('🔴 refuses a split while the icon or the cover is rated above SFW, and writes nothing', async () => {
    for (const f of [
      { iconId: R_ICON, coverId: COVER },
      { iconId: ICON, coverId: R_ICON },
    ]) {
      const err = await grant(LISTING, f).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('BAD_REQUEST');
      expect((err as TRPCError).message).toBe(MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE);
      expect(await s.stamp(LISTING)).toBeNull();
    }
  });

  it('an actor without a stamp is refused by the table itself', async () => {
    await expect(
      s.db.query(
        `INSERT INTO app_listing_red_media (app_listing_id, media_split_approved_by) VALUES ($1, $2)`,
        [LISTING, MOD]
      )
    ).rejects.toThrow(/app_listing_red_media_split_actor_chk/);
  });

  it("🔴 deleting the moderator's account keeps the split and only drops the actor", async () => {
    // A two-way "both or neither" CHECK beside this ON DELETE SET NULL would make the delete fail.
    await grant();
    await s.db.query(`DELETE FROM "User" WHERE id = $1`, [MOD]);
    expect(await s.stamp(LISTING)).toEqual({ at: expect.any(String), by: null });
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(true);
  });

  it('deleting the listing deletes its decision', async () => {
    await grant();
    await s.db.query(`DELETE FROM app_listings WHERE id = $1`, [LISTING]);
    expect(await s.stamp(LISTING)).toBeNull();
  });

  it('the migration is idempotent', async () => {
    await grant();
    await s.applyMigration();
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(true);
  });
});

/** `pgliteRaw`'s parameterisation, bound to one transaction's connection. */
function createTxRaw(tx: Pick<PGlite, 'query'>) {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    return tx.query(sql.text, sql.values);
  };
  return {
    $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).rows) as never,
    $executeRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).affectedRows ?? 0) as never,
  };
}
