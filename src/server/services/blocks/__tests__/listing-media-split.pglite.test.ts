import type { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  applyListingMediaSplitDecision,
  MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE,
  MEDIA_SPLIT_NOT_WRITABLE_MESSAGE,
  MEDIA_SPLIT_UNAVAILABLE_MESSAGE,
  readListingMediaSplit,
  readListingMediaSplitState,
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
    // No table, no split: the review read can tell, so it says unsplit rather than "cannot tell".
    expect(await readListingMediaSplitState(s.raw, LISTING)).toBe(false);
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

describe('with the table PRESENT but not granted to the role the app connects as', () => {
  // The migration is applied by hand, and a table created by a human's role is not necessarily
  // readable or writable by the app's. Each case below runs AS a role holding only the named
  // privileges on the table (and everything on the others), via `SET ROLE`.
  let s: SplitDb;
  beforeAll(async () => {
    s = await createSplitDb();
    await s.applyMigration();
  });
  afterAll(() => s.db.close());
  beforeEach(async () => {
    await s.unrestrict();
    await s.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
    await s.seed({
      listingIds: [LISTING],
      images: { [ICON]: NsfwLevel.PG, [COVER]: NsfwLevel.PG },
      users: [MOD],
    });
  });

  /** A split stamped by the owning role, before the app's role lost (or never had) its grant. */
  const stampAsOwner = () =>
    s.db.query(
      `INSERT INTO app_listing_red_media (app_listing_id, media_split_approved_at, media_split_approved_by)
       VALUES ($1, now(), $2)`,
      [LISTING, MOD]
    );

  /**
   * Refused by the service, up front — a `TRPCError` carrying the moderator-facing message — not
   * by Postgres. The literal fragment keeps the check meaningful against code that never
   * exported the constant.
   */
  async function expectNotWritable(p: Promise<unknown>) {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect((err as TRPCError).message).toMatch(/not permitted to update it/);
    expect((err as TRPCError).message).toBe(MEDIA_SPLIT_NOT_WRITABLE_MESSAGE);
  }

  const decide = (decision?: 'split' | 'rate-mature') =>
    applyListingMediaSplitDecision(s.raw, {
      appListingId: LISTING,
      face,
      decision,
      actorUserId: MOD,
    });

  it('positive control: the restricted role really cannot read it', async () => {
    await s.restrictTo([]);
    await expect(s.db.query(`SELECT 1 FROM app_listing_red_media`)).rejects.toThrow(
      /permission denied/
    );
  });

  it('🔴 unreadable: a read is "unsplit", even for a stamped listing, and does not throw', async () => {
    await stampAsOwner();
    await s.restrictTo([]);
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(false);
  });

  it('🔴 unreadable: a read never aborts the transaction it runs in', async () => {
    await s.restrictTo([]);
    const after = await s.db.transaction(async (tx) => {
      await readListingMediaSplit(createTxRaw(tx), LISTING);
      return (await tx.query<{ n: number }>(`SELECT 41 + 1 AS n`)).rows[0].n;
    });
    expect(after).toBe(42);
  });

  it('positive control: with SELECT granted the same read sees the stamp', async () => {
    await stampAsOwner();
    await s.restrictTo(['SELECT']);
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(true);
  });

  it('🔴 unreadable: an explicit rate-mature is refused, saying why', async () => {
    await stampAsOwner();
    await s.restrictTo([]);
    await expectNotWritable(decide('rate-mature'));
    expect(await s.stamp(LISTING)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('🔴 unreadable: NO decision has nothing it can see to clear — it succeeds and leaves the stamp', async () => {
    // Operator decision (2026-10-18): as before the split existed. The stamp it cannot see stays,
    // and would take effect again if SELECT were granted (the accepted limitation).
    await stampAsOwner();
    await s.restrictTo([]);
    expect(await decide()).toBe(false);
    expect(await s.stamp(LISTING)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('🔴 UPDATE without SELECT: NO decision issues no UPDATE, and never aborts the transaction', async () => {
    // The clear's WHERE needs SELECT, so issuing it here would fail on the privilege.
    await stampAsOwner();
    await s.restrictTo(['UPDATE']);
    const after = await s.db.transaction(async (tx) => {
      expect(
        await applyListingMediaSplitDecision(createTxRaw(tx), {
          appListingId: LISTING,
          face,
          decision: undefined,
          actorUserId: MOD,
        })
      ).toBe(false);
      return (await tx.query<{ n: number }>(`SELECT 41 + 1 AS n`)).rows[0].n;
    });
    expect(after).toBe(42);
    expect(await s.stamp(LISTING)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('positive control: the UPDATE-only role really cannot run the clear', async () => {
    await s.restrictTo(['UPDATE']);
    await expect(
      s.db.query(
        `UPDATE app_listing_red_media SET media_split_approved_at = NULL
         WHERE app_listing_id = $1 AND media_split_approved_at IS NOT NULL`,
        [LISTING]
      )
    ).rejects.toThrow(/permission denied/);
  });

  it('🔴 unreadable: the review read reports "cannot tell", not "unsplit"', async () => {
    await stampAsOwner();
    await s.restrictTo([]);
    expect(await readListingMediaSplitState(s.raw, LISTING)).toBeNull();
    // ...while the fail-safe read the rating floors use still reads unsplit.
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(false);
  });

  it('positive control: granted SELECT the review read sees the stamp, and an unstamped listing as unsplit', async () => {
    await stampAsOwner();
    await s.seed({ listingIds: [OTHER] });
    await s.restrictTo(['SELECT']);
    expect(await readListingMediaSplitState(s.raw, LISTING)).toBe(true);
    expect(await readListingMediaSplitState(s.raw, OTHER)).toBe(false);
  });

  it('🔴 read-only and the listing is not split: clearing has nothing to do and succeeds', async () => {
    await s.restrictTo(['SELECT']);
    expect(await decide()).toBe(false);
    expect(await decide('rate-mature')).toBe(false);
  });

  it('🔴 read-only and the listing IS split: clearing is refused and the stamp stays', async () => {
    await stampAsOwner();
    await s.restrictTo(['SELECT']);
    await expectNotWritable(decide('rate-mature'));
    // With no decision too: a split this role can see and cannot end is not silently kept.
    await expectNotWritable(decide());
    expect(await s.stamp(LISTING)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('🔴 a split without INSERT and UPDATE is refused as not writable, not as unavailable', async () => {
    for (const privileges of [
      [],
      ['SELECT'],
      ['SELECT', 'INSERT'],
      ['SELECT', 'UPDATE'],
    ] as const) {
      await s.restrictTo([...privileges]);
      await expectNotWritable(decide('split'));
      expect(await s.stamp(LISTING)).toBeNull();
    }
  });

  it('🔴 a refusal never aborts the transaction it runs in', async () => {
    await s.restrictTo([]);
    const after = await s.db.transaction(async (tx) => {
      await applyListingMediaSplitDecision(createTxRaw(tx), {
        appListingId: LISTING,
        face,
        decision: 'split',
        actorUserId: MOD,
      }).catch(() => undefined);
      return (await tx.query<{ n: number }>(`SELECT 41 + 1 AS n`)).rows[0].n;
    });
    expect(after).toBe(42);
  });

  it('positive control: with SELECT, INSERT and UPDATE the restricted role grants and clears', async () => {
    await s.restrictTo(['SELECT', 'INSERT', 'UPDATE']);
    expect(await decide('split')).toBe(true);
    expect(await readListingMediaSplit(s.raw, LISTING)).toBe(true);
    expect(await decide('rate-mature')).toBe(false);
    expect(await s.stamp(LISTING)).toEqual({ at: null, by: null });
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
