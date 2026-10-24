import type { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  applyListingMediaSplitDecision,
  applyRevisionRedSlots,
  cloneListingRedSlots,
  listListingIdsWithRedSlotImage,
  probeListingMediaSplitTable,
  readListingMediaSplit,
  readListingRedMediaManyForRender,
  readListingRedSlotAssets,
  readListingRedSlots,
  RED_SLOTS_UNAVAILABLE_MESSAGE,
  writeListingRedSlot,
} from '~/server/services/blocks/listing-media-split.service';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * The civitai.red icon / cover OVERRIDE SLOTS against the REAL migrations: with only the first
 * (the split table) applied — the state of an environment between the two manual applies — and
 * with both, and with the table present but not granted to the role a read connects as (the read
 * client's role may lack SELECT; the role that writes the table must hold every grant, so an
 * owner's slot write and a revision apply are not probed for privileges — the clone every revision
 * open runs is, and is skipped without INSERT and UPDATE).
 *
 * Fixture ids are pairwise distinct and distinct from every constant the code names: listings
 * `apl_red_live` / `apl_red_shadow` / `apl_red_other`, images 31 (PG) / 32 (R) / 33 (XXX) /
 * 34 (PG-13), moderator 702.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const LIVE = 'apl_red_live';
const SHADOW = 'apl_red_shadow';
const OTHER = 'apl_red_other';
const MOD = 702;
const PG_IMG = 31;
const R_IMG = 32;
const XXX_IMG = 33;
const PG13_IMG = 34;

function createTxRaw(tx: { query: PGlite['query'] }) {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    return tx.query(sql.text, sql.values);
  };
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).rows,
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, ...values)).affectedRows ?? 0,
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
}

async function seed(s: SplitDb) {
  await s.seed({ listingIds: [LIVE, SHADOW, OTHER], users: [MOD] });
  await s.seedImages([
    { id: PG_IMG, nsfwLevel: NsfwLevel.PG, url: 'pg.png' },
    { id: R_IMG, nsfwLevel: NsfwLevel.R, url: 'r.png' },
    { id: XXX_IMG, nsfwLevel: NsfwLevel.XXX, url: 'xxx.png' },
    { id: PG13_IMG, nsfwLevel: NsfwLevel.PG13, url: 'pg13.png' },
  ]);
}

describe('only the split table applied — the override columns are ABSENT', () => {
  let s: SplitDb;
  beforeAll(async () => {
    s = await createSplitDb();
    await s.applyMigration();
    await seed(s);
  });
  afterAll(() => s.db.close());

  it('the probe sees the table but not the override columns', async () => {
    expect(await probeListingMediaSplitTable(s.raw)).toEqual({
      present: true,
      select: true,
      insert: true,
      update: true,
      redSlots: false,
    });
  });

  it('every read is "no overrides", and none of them throws', async () => {
    expect(await readListingRedSlots(s.raw, LIVE)).toEqual({
      available: false,
      staged: false,
      redIconId: null,
      redCoverId: null,
    });
    expect(await readListingRedSlotAssets(s.raw, LIVE)).toEqual([]);
    expect(await listListingIdsWithRedSlotImage(s.raw, R_IMG)).toEqual([]);
    expect((await readListingRedMediaManyForRender(s.raw, [LIVE])).size).toBe(0);
  });

  it('🔴 setting an override is refused, saying it is not available yet', async () => {
    await expect(
      writeListingRedSlot(s.raw, { appListingId: LIVE, slot: 'icon', imageId: R_IMG })
    ).rejects.toThrow(RED_SLOTS_UNAVAILABLE_MESSAGE);
  });

  it('🔴 clone, apply and every read never abort the transaction they run in', async () => {
    const after = await s.db.transaction(async (tx) => {
      const raw = createTxRaw(tx);
      await readListingRedSlots(raw, LIVE);
      await readListingRedSlotAssets(raw, LIVE);
      await cloneListingRedSlots(raw, { fromListingId: LIVE, toListingId: SHADOW });
      await applyRevisionRedSlots(raw, { shadowId: SHADOW, parentId: LIVE });
      await expect(
        writeListingRedSlot(raw, { appListingId: LIVE, slot: 'cover', imageId: R_IMG })
      ).rejects.toThrow(RED_SLOTS_UNAVAILABLE_MESSAGE);
      return (await tx.query<{ n: number }>(`SELECT 40 + 2 AS n`)).rows[0].n;
    });
    expect(after).toBe(42);
  });

  it('🔴 the split itself keeps working without the override columns', async () => {
    expect(
      await applyListingMediaSplitDecision(s.raw, {
        appListingId: LIVE,
        face: { iconId: PG_IMG, coverId: PG_IMG },
        decision: 'split',
        actorUserId: MOD,
      })
    ).toBe(true);
    expect(await readListingMediaSplit(s.raw, LIVE)).toBe(true);
  });
});

describe('both migrations applied', () => {
  let s: SplitDb;
  beforeAll(async () => {
    s = await createSplitDb();
    await s.applyMigration();
    await s.applyRedSlotsMigration();
  });
  afterAll(() => s.db.close());
  beforeEach(async () => {
    await s.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
    await seed(s);
  });

  it('the probe sees the override columns', async () => {
    expect((await probeListingMediaSplitTable(s.raw)).redSlots).toBe(true);
  });

  it('sets and clears each slot independently, and reads them back for that listing only', async () => {
    await writeListingRedSlot(s.raw, { appListingId: LIVE, slot: 'icon', imageId: R_IMG });
    await writeListingRedSlot(s.raw, { appListingId: LIVE, slot: 'cover', imageId: XXX_IMG });
    expect(await readListingRedSlots(s.raw, LIVE)).toEqual({
      available: true,
      staged: true,
      redIconId: R_IMG,
      redCoverId: XXX_IMG,
    });
    // No row: nothing staged (the revision-apply's "leave the live overrides alone" signal).
    expect(await readListingRedSlots(s.raw, OTHER)).toEqual({
      available: true,
      staged: false,
      redIconId: null,
      redCoverId: null,
    });
    await writeListingRedSlot(s.raw, { appListingId: LIVE, slot: 'icon', imageId: null });
    expect(await s.redSlots(LIVE)).toEqual({ icon: null, cover: XXX_IMG });
  });

  it('🔴 an override write never touches the split decision, and a split decision never touches the overrides', async () => {
    await applyListingMediaSplitDecision(s.raw, {
      appListingId: LIVE,
      face: { iconId: PG_IMG, coverId: PG_IMG },
      decision: 'split',
      actorUserId: MOD,
    });
    await writeListingRedSlot(s.raw, { appListingId: LIVE, slot: 'icon', imageId: R_IMG });
    expect(await s.stamp(LIVE)).toEqual({ at: expect.any(String), by: MOD });
    await applyListingMediaSplitDecision(s.raw, {
      appListingId: LIVE,
      face: { iconId: PG_IMG, coverId: PG_IMG },
      decision: 'rate-mature',
      actorUserId: MOD,
    });
    expect(await s.redSlots(LIVE)).toEqual({ icon: R_IMG, cover: null });
    expect(await s.stamp(LIVE)).toEqual({ at: null, by: null });
  });

  it('the floor read returns each filled slot with its image level and scan state', async () => {
    await s.setRedSlots(LIVE, { icon: R_IMG, cover: XXX_IMG });
    expect(await readListingRedSlotAssets(s.raw, LIVE)).toEqual([
      { slot: 'icon', imageId: R_IMG, nsfwLevel: NsfwLevel.R, ingestion: 'Scanned', redSlot: true },
      {
        slot: 'cover',
        imageId: XXX_IMG,
        nsfwLevel: NsfwLevel.XXX,
        ingestion: 'Scanned',
        redSlot: true,
      },
    ]);
    expect(await readListingRedSlotAssets(s.raw, OTHER)).toEqual([]);
  });

  it('the render read carries every column the store gate reads, keyed by listing', async () => {
    await s.seedImages([
      {
        id: R_IMG,
        nsfwLevel: NsfwLevel.R,
        url: 'r.png',
        needsReview: 'poi',
        poi: true,
        minor: false,
        tosViolation: true,
        acceptableMinor: true,
        blockedFor: 'x',
      },
    ]);
    await s.setRedSlots(LIVE, { icon: R_IMG, cover: null });
    await s.setRedSlots(OTHER, { icon: null, cover: PG13_IMG });
    const out = await readListingRedMediaManyForRender(s.raw, [LIVE, OTHER, SHADOW]);
    expect(out.get(LIVE)).toEqual({
      icon: {
        id: R_IMG,
        url: 'r.png',
        nsfwLevel: NsfwLevel.R,
        ingestion: 'Scanned',
        needsReview: 'poi',
        poi: true,
        minor: false,
        tosViolation: true,
        acceptableMinor: true,
        blockedFor: 'x',
      },
      cover: null,
    });
    expect(out.get(OTHER)?.cover?.id).toBe(PG13_IMG);
    expect(out.get(OTHER)?.icon).toBeNull();
    expect(out.has(SHADOW)).toBe(false);
  });

  it('finds the listings whose override shows an image', async () => {
    await s.setRedSlots(LIVE, { icon: R_IMG, cover: null });
    await s.setRedSlots(OTHER, { icon: null, cover: R_IMG });
    expect((await listListingIdsWithRedSlotImage(s.raw, R_IMG)).sort()).toEqual([LIVE, OTHER]);
    expect(await listListingIdsWithRedSlotImage(s.raw, PG_IMG)).toEqual([]);
  });

  describe('a revision round trip', () => {
    it('🔴 clone copies the live overrides onto the shadow, never the split decision', async () => {
      await applyListingMediaSplitDecision(s.raw, {
        appListingId: LIVE,
        face: { iconId: PG_IMG, coverId: PG_IMG },
        decision: 'split',
        actorUserId: MOD,
      });
      await writeListingRedSlot(s.raw, { appListingId: LIVE, slot: 'cover', imageId: XXX_IMG });
      await cloneListingRedSlots(s.raw, { fromListingId: LIVE, toListingId: SHADOW });
      expect(await s.redSlots(SHADOW)).toEqual({ icon: null, cover: XXX_IMG });
      expect(await s.stamp(SHADOW)).toEqual({ at: null, by: null });
    });

    it('clone of a listing with no override creates no shadow row', async () => {
      await applyListingMediaSplitDecision(s.raw, {
        appListingId: LIVE,
        face: { iconId: PG_IMG, coverId: PG_IMG },
        decision: 'split',
        actorUserId: MOD,
      });
      await cloneListingRedSlots(s.raw, { fromListingId: LIVE, toListingId: SHADOW });
      expect(await s.redSlots(SHADOW)).toBeNull();
    });

    it('🔴 T10: a revision that did not touch the overrides leaves them as they were', async () => {
      await s.setRedSlots(LIVE, { icon: R_IMG, cover: XXX_IMG });
      await cloneListingRedSlots(s.raw, { fromListingId: LIVE, toListingId: SHADOW });
      // …the owner edits only a SFW screenshot on the shadow (not this table)…
      await applyRevisionRedSlots(s.raw, { shadowId: SHADOW, parentId: LIVE });
      expect(await s.redSlots(LIVE)).toEqual({ icon: R_IMG, cover: XXX_IMG });
    });

    it('🔴 the shadow’s overrides replace the live ones — a cleared slot included — and the split stays', async () => {
      await s.setRedSlots(LIVE, { icon: R_IMG, cover: XXX_IMG });
      await applyListingMediaSplitDecision(s.raw, {
        appListingId: LIVE,
        face: { iconId: PG_IMG, coverId: PG_IMG },
        decision: 'split',
        actorUserId: MOD,
      });
      await cloneListingRedSlots(s.raw, { fromListingId: LIVE, toListingId: SHADOW });
      await writeListingRedSlot(s.raw, { appListingId: SHADOW, slot: 'icon', imageId: PG13_IMG });
      await writeListingRedSlot(s.raw, { appListingId: SHADOW, slot: 'cover', imageId: null });
      await applyRevisionRedSlots(s.raw, { shadowId: SHADOW, parentId: LIVE });
      expect(await s.redSlots(LIVE)).toEqual({ icon: PG13_IMG, cover: null });
      expect(await s.stamp(LIVE)).toEqual({ at: expect.any(String), by: MOD });
    });

    it('applies an override first set on the revision to a live listing that had no row', async () => {
      await writeListingRedSlot(s.raw, { appListingId: SHADOW, slot: 'cover', imageId: R_IMG });
      await applyRevisionRedSlots(s.raw, { shadowId: SHADOW, parentId: LIVE });
      expect(await s.redSlots(LIVE)).toEqual({ icon: null, cover: R_IMG });
    });

    it('🔴 a shadow that staged nothing (no row) leaves the live overrides alone', async () => {
      // The clone was skipped (say, a role that could not INSERT): no row on the shadow must
      // not read as "cleared both".
      await s.setRedSlots(LIVE, { icon: R_IMG, cover: XXX_IMG });
      await applyRevisionRedSlots(s.raw, { shadowId: SHADOW, parentId: LIVE });
      expect(await s.redSlots(LIVE)).toEqual({ icon: R_IMG, cover: XXX_IMG });
    });
  });

  it('🔴 deleting an image empties the slot that showed it (ON DELETE SET NULL)', async () => {
    await s.setRedSlots(LIVE, { icon: R_IMG, cover: XXX_IMG });
    await s.db.query(`DELETE FROM "Image" WHERE id = $1`, [R_IMG]);
    expect(await s.redSlots(LIVE)).toEqual({ icon: null, cover: XXX_IMG });
  });

  it('a slot may only name an image that exists', async () => {
    await expect(
      writeListingRedSlot(s.raw, { appListingId: LIVE, slot: 'icon', imageId: 999_001 })
    ).rejects.toThrow(/foreign key/);
  });

  it('the override migration is idempotent', async () => {
    await s.setRedSlots(LIVE, { icon: R_IMG, cover: null });
    await s.applyRedSlotsMigration();
    expect(await s.redSlots(LIVE)).toEqual({ icon: R_IMG, cover: null });
    const { rows } = await s.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_indexes
       WHERE tablename = 'app_listing_red_media'
         AND indexname IN ('app_listing_red_media_red_icon_idx', 'app_listing_red_media_red_cover_idx')`
    );
    expect(rows[0].n).toBe(2);
  });

  it('the rollback in the migration header removes the columns and the code reads "no overrides"', async () => {
    const t = await createSplitDb();
    try {
      await t.applyMigration();
      await t.applyRedSlotsMigration();
      await t.db.exec(`
        BEGIN;
        SET LOCAL lock_timeout = '3s';
        ALTER TABLE "app_listing_red_media"
          DROP COLUMN IF EXISTS "red_icon_id",
          DROP COLUMN IF EXISTS "red_cover_id";
        COMMIT;
      `);
      expect((await probeListingMediaSplitTable(t.raw)).redSlots).toBe(false);
      expect((await readListingRedSlots(t.raw, LIVE)).available).toBe(false);
    } finally {
      await t.db.close();
    }
  });
});

describe('both migrations applied, the table NOT granted to the role a read connects as', () => {
  let s: SplitDb;
  beforeAll(async () => {
    s = await createSplitDb();
    await s.applyMigration();
    await s.applyRedSlotsMigration();
  });
  afterAll(() => s.db.close());
  beforeEach(async () => {
    await s.unrestrict();
    await s.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
    await seed(s);
    await s.setRedSlots(LIVE, { icon: R_IMG, cover: XXX_IMG });
  });

  it('positive control: the restricted role really cannot read it', async () => {
    await s.restrictTo([]);
    await expect(s.db.query(`SELECT * FROM app_listing_red_media`)).rejects.toThrow(
      /permission denied/
    );
  });

  it('🔴 no SELECT: every read is "no overrides", the render read does not throw', async () => {
    await s.restrictTo([]);
    expect(await readListingRedSlots(s.raw, LIVE)).toEqual({
      available: false,
      staged: false,
      redIconId: null,
      redCoverId: null,
    });
    expect(await readListingRedSlotAssets(s.raw, LIVE)).toEqual([]);
    // The render read's catch-all would also turn a permission error into "no overrides", so
    // pin that it never got that far: the PROBE answered, nothing failed and nothing was logged.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await readListingRedMediaManyForRender(s.raw, [LIVE])).size).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('positive control: with SELECT granted the same reads see the overrides', async () => {
    await s.restrictTo(['SELECT']);
    expect((await readListingRedSlots(s.raw, LIVE)).redIconId).toBe(R_IMG);
    expect((await readListingRedMediaManyForRender(s.raw, [LIVE])).get(LIVE)?.cover?.id).toBe(
      XXX_IMG
    );
  });

  it('🔴 SELECT without INSERT: the revision clone is skipped and never aborts its transaction', async () => {
    await s.restrictTo(['SELECT']);
    const after = await s.db.transaction(async (tx) => {
      await cloneListingRedSlots(createTxRaw(tx), { fromListingId: OTHER, toListingId: SHADOW });
      await cloneListingRedSlots(createTxRaw(tx), { fromListingId: LIVE, toListingId: SHADOW });
      return (await tx.query<{ n: number }>(`SELECT 40 + 2 AS n`)).rows[0].n;
    });
    expect(after).toBe(42);
    expect(await s.redSlots(SHADOW)).toBeNull();
  });

  it('🔴 SELECT and INSERT without UPDATE: the clone stages nothing, so the apply keeps the live overrides', async () => {
    // The apply is an upsert (`ON CONFLICT … DO UPDATE`), which PostgreSQL refuses without
    // UPDATE even when no row conflicts — so a row the clone staged here could never be applied.
    await s.restrictTo(['SELECT', 'INSERT']);
    await cloneListingRedSlots(s.raw, { fromListingId: LIVE, toListingId: SHADOW });
    await applyRevisionRedSlots(s.raw, { shadowId: SHADOW, parentId: LIVE });
    expect(await s.redSlots(LIVE)).toEqual({ icon: R_IMG, cover: XXX_IMG });
    expect(await s.redSlots(SHADOW)).toBeNull();
  });

  it('positive control: with INSERT and UPDATE the same clone copies the overrides', async () => {
    await s.restrictTo(['SELECT', 'INSERT', 'UPDATE']);
    await cloneListingRedSlots(s.raw, { fromListingId: LIVE, toListingId: SHADOW });
    expect(await s.redSlots(SHADOW)).toEqual({ icon: R_IMG, cover: XXX_IMG });
  });
});
