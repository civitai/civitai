import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boxOddsSnapshotSchema,
  snapshotOfLiveBox,
  snapshotsMatch,
} from '@civitai/shared/box-odds-snapshot';
import type { BoxDraft } from '$lib/mystery-box';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { BoxRefusal, createBox, createBoxListing, recordOutsideChange, saveBox, updateBoxListing } =
  await import('../mystery-box-builder.service');
const { createCosmeticDefinitions } = await import('../item-definitions.service');

// The real migrations, so their CHECKs, FKs and unique indexes bind the builder as they do in
// production.
const MIGRATIONS = [
  '20261105120000_mystery_box_items',
  '20261107120000_mystery_box_listing_unlisted_and_refunds',
].map((name) =>
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  )
);

// Stand-ins for the tables the migration references, with the columns the builder touches.
const BASE = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY);
CREATE TABLE "Cosmetic" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'ContentDecoration',
  "data" JSONB
);
CREATE TABLE "CosmeticShopItem" (
  "id" SERIAL PRIMARY KEY,
  "cosmeticId" INTEGER,
  "unitAmount" INTEGER NOT NULL,
  "addedById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "availableFrom" TIMESTAMP(3),
  "availableTo" TIMESTAMP(3),
  "availableQuantity" INTEGER,
  "meta" JSONB NOT NULL DEFAULT '{}',
  "title" TEXT NOT NULL,
  "description" TEXT,
  "archivedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "listed" BOOLEAN NOT NULL DEFAULT true
);
`;

const EVENT = 'party';
const MOD = 5;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(BASE);
  for (const migration of MIGRATIONS) await db.exec(migration);
  await db.exec(`
    INSERT INTO "Cosmetic" ("id", "name", "data") VALUES
      (1, 'Blue cap',  '{"event":"party","team":"Blue"}'),
      (2, 'Pink cap',  '{"event":"party","team":"Pink"}'),
      (3, 'Blue crown','{"event":"party","team":"Blue"}'),
      (4, 'Pink crown','{"event":"party","team":"Pink"}'),
      (5, 'Confetti',  '{"event":"party"}'),
      (9, 'Elsewhere', '{"event":"other","team":"Green"}');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  await createCosmeticDefinitions({ selector: { event: EVENT }, userId: MOD });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const rows = async <T>(query: string, params: unknown[] = []) =>
  (await db.query<T>(query, params)).rows;

const defOf = async (cosmeticId: number) =>
  (
    await rows<{ id: number }>(`SELECT id FROM "ItemDefinition" WHERE "cosmeticId" = $1`, [
      cosmeticId,
    ])
  )[0].id;

const boxRow = async (id: number) =>
  (
    await rows<{ version: number; status: string; name: string }>(
      `SELECT version, status, name FROM "ItemDefinition" WHERE id = $1`,
      [id]
    )
  )[0];

const snapshots = async (boxId: number) =>
  rows<{ version: number; snapshot: unknown }>(
    `SELECT version, snapshot FROM "BoxOddsSnapshot" WHERE "boxDefinitionId" = $1 ORDER BY version`,
    [boxId]
  );

/** Read the way the draw and the odds page read it. */
const liveBox = async (boxId: number) => {
  const tiers = await rows<{
    id: number;
    key: string;
    name: string;
    weight: number;
    sortOrder: number;
  }>(`SELECT id, key, name, weight, "sortOrder" FROM "BoxTier" WHERE "boxDefinitionId" = $1`, [
    boxId,
  ]);
  const contents = await rows<{ tierId: number; cosmeticId: number }>(
    `SELECT bc."tierId", d."cosmeticId" FROM "BoxContent" bc
     JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
     WHERE bc."boxDefinitionId" = $1 AND bc.enabled AND d.type = 'cosmetic'`,
    [boxId]
  );
  return snapshotOfLiveBox(tiers, contents);
};

async function saveAt(input: Omit<Parameters<typeof saveBox>[0], 'expectedUpdatedAt'>) {
  const [{ updatedAt }] = await rows<{ updatedAt: Date }>(
    `SELECT "updatedAt" FROM "ItemDefinition" WHERE id = $1`,
    [input.boxId]
  );
  return saveBox({ ...input, expectedUpdatedAt: new Date(updatedAt).toISOString() });
}

/** A two-tier party box, every tier stocked for both teams. */
async function partyDraft(): Promise<BoxDraft> {
  return {
    name: 'Party Box',
    description: '',
    imageUrl: '',
    event: EVENT,
    emptyRule: 'keep',
    art: {},
    tiers: [
      { id: null, key: 'common', name: 'Common', weight: 3, color: '#9ca3af' },
      { id: null, key: 'rare', name: 'Rare', weight: 1, color: '#3b82f6' },
    ],
    contents: [
      { id: null, rewardDefinitionId: await defOf(1), tierKey: 'common', enabled: true },
      { id: null, rewardDefinitionId: await defOf(2), tierKey: 'common', enabled: true },
      { id: null, rewardDefinitionId: await defOf(3), tierKey: 'rare', enabled: true },
      { id: null, rewardDefinitionId: await defOf(4), tierKey: 'rare', enabled: true },
    ],
  };
}

/** The editor's draft after a save: the same box, with the ids the server gave each row. */
async function savedDraft(boxId: number, base: BoxDraft): Promise<BoxDraft> {
  const tiers = await rows<{ id: number; key: string }>(
    `SELECT id, key FROM "BoxTier" WHERE "boxDefinitionId" = $1`,
    [boxId]
  );
  const contents = await rows<{ id: number; rewardDefinitionId: number }>(
    `SELECT id, "rewardDefinitionId" FROM "BoxContent" WHERE "boxDefinitionId" = $1`,
    [boxId]
  );
  return {
    ...base,
    tiers: base.tiers.map((t) => ({ ...t, id: tiers.find((r) => r.key === t.key)?.id ?? null })),
    contents: base.contents.map((c) => ({
      ...c,
      id: contents.find((r) => r.rewardDefinitionId === c.rewardDefinitionId)?.id ?? null,
    })),
  };
}

async function publishedBox() {
  const boxId = await createBox({ name: 'Party Box', userId: MOD });
  const draft = await partyDraft();
  await saveAt({ boxId, expectedVersion: 1, draft, publish: true, userId: MOD });
  return { boxId, draft: await savedDraft(boxId, draft) };
}

const V2_SNAPSHOT = {
  tiers: [
    { key: 'common', name: 'Common', weight: 3 },
    { key: 'rare', name: 'Rare', weight: 1 },
  ],
  contents: [
    { tier: 'common', cosmeticId: 1 },
    { tier: 'common', cosmeticId: 2 },
    { tier: 'rare', cosmeticId: 3 },
    { tier: 'rare', cosmeticId: 4 },
  ],
};

describe('publishing a box', () => {
  it('bumps the version and writes that version a snapshot the odds page reads as the live box', async () => {
    const { boxId } = await publishedBox();

    expect(await boxRow(boxId)).toMatchObject({ version: 2, status: 'published' });
    const written = await snapshots(boxId);
    expect(written.map((s) => s.version)).toEqual([2]);
    const parsed = boxOddsSnapshotSchema.safeParse(written[0].snapshot);
    expect(parsed.success).toBe(true);
    // Written out by hand, so a fault in the shared helper can't cancel itself out.
    expect(parsed.data).toEqual(V2_SNAPSHOT);
    expect(snapshotsMatch(parsed.data!, await liveBox(boxId))).toBe(true);
  });

  it('is refused while a team has nothing in a tier, and writes nothing', async () => {
    const boxId = await createBox({ name: 'Party Box', userId: MOD });
    const draft = await partyDraft();
    draft.contents = draft.contents.filter((c, i) => i !== 3); // no Pink rare

    await expect(
      saveAt({ boxId, expectedVersion: 1, draft, publish: true, userId: MOD })
    ).rejects.toThrow('Rare has nothing for team Pink.');
    expect(await boxRow(boxId)).toMatchObject({ version: 1, status: 'draft' });
    expect(await rows(`SELECT 1 FROM "BoxTier"`)).toEqual([]);
    expect(await snapshots(boxId)).toEqual([]);
  });

  it("counts a team the event's cosmetics name even when the box holds nothing for it", async () => {
    await db.query(
      `INSERT INTO "Cosmetic" ("id", "name", "data") VALUES (6, 'Yellow cap', '{"event":"party","team":"Yellow"}')`
    );
    const boxId = await createBox({ name: 'Party Box', userId: MOD });

    await expect(
      saveAt({ boxId, expectedVersion: 1, draft: await partyDraft(), publish: true, userId: MOD })
    ).rejects.toThrow('Common has nothing for team Yellow.');
    expect(await boxRow(boxId)).toMatchObject({ version: 1, status: 'draft' });
  });
});

describe('a box with no event', () => {
  it('is refused while it holds a cosmetic made for a team: its buyers have no team', async () => {
    const boxId = await createBox({ name: 'Party Box', userId: MOD });
    const draft = { ...(await partyDraft()), event: '' };

    await expect(
      saveAt({ boxId, expectedVersion: 1, draft, publish: true, userId: MOD })
    ).rejects.toThrow("but this box's buyers have no team, so nobody can draw it.");
    expect(await boxRow(boxId)).toMatchObject({ version: 1, status: 'draft' });
  });

  it('publishes when every tier holds a cosmetic made for no team', async () => {
    const boxId = await createBox({ name: 'Confetti Box', userId: MOD });
    const draft: BoxDraft = {
      ...(await partyDraft()),
      event: '',
      tiers: [{ id: null, key: 'common', name: 'Common', weight: 1, color: null }],
      contents: [
        { id: null, rewardDefinitionId: await defOf(5), tierKey: 'common', enabled: true },
      ],
    };

    await saveAt({ boxId, expectedVersion: 1, draft, publish: true, userId: MOD });
    expect(await boxRow(boxId)).toMatchObject({ version: 2, status: 'published' });
  });
});

describe('editing a published box', () => {
  it('writes the next version a snapshot of the edited box and leaves the earlier one alone', async () => {
    const { boxId, draft } = await publishedBox();
    const confetti = await defOf(5);
    const edited: BoxDraft = {
      ...draft,
      tiers: draft.tiers.map((t) => (t.key === 'rare' ? { ...t, weight: 2 } : t)),
      contents: [
        ...draft.contents.map((c) =>
          c.rewardDefinitionId === draft.contents[1].rewardDefinitionId
            ? { ...c, enabled: false }
            : c
        ),
        { id: null, rewardDefinitionId: confetti, tierKey: 'common', enabled: true },
      ],
    };

    const result = await saveAt({
      boxId,
      expectedVersion: 2,
      draft: edited,
      publish: false,
      userId: MOD,
    });

    expect(result).toEqual({ version: 3, status: 'published', bumped: true });
    const written = await snapshots(boxId);
    expect(written.map((s) => s.version)).toEqual([2, 3]);
    expect(written[0].snapshot).toEqual(V2_SNAPSHOT);
    expect(written[1].snapshot).toEqual({
      tiers: [
        { key: 'common', name: 'Common', weight: 3 },
        { key: 'rare', name: 'Rare', weight: 2 },
      ],
      contents: [
        { tier: 'common', cosmeticId: 1 },
        { tier: 'common', cosmeticId: 5 },
        { tier: 'rare', cosmeticId: 3 },
        { tier: 'rare', cosmeticId: 4 },
      ],
    });
    expect(
      snapshotsMatch(boxOddsSnapshotSchema.parse(written[1].snapshot), await liveBox(boxId))
    ).toBe(true);
  });

  it('commits the bump with the change: a snapshot that fails to write leaves the box at its old version and rows', async () => {
    const { boxId, draft } = await publishedBox();
    // A row already at the next version makes the snapshot insert fail on its primary key, after the
    // tiers and the version have been written in the same transaction.
    await db.query(
      `INSERT INTO "BoxOddsSnapshot" ("boxDefinitionId", version, snapshot) VALUES ($1, 3, '{}')`,
      [boxId]
    );
    const before = await liveBox(boxId);
    const edited = { ...draft, tiers: draft.tiers.map((t) => ({ ...t, weight: t.weight + 1 })) };

    await expect(
      saveAt({ boxId, expectedVersion: 2, draft: edited, publish: false, userId: MOD })
    ).rejects.toThrow();

    expect(await boxRow(boxId)).toMatchObject({ version: 2, status: 'published' });
    expect(await liveBox(boxId)).toEqual(before);
  });

  it('moves contents out of a tier and removes the tier in one save', async () => {
    const { boxId, draft } = await publishedBox();
    const edited: BoxDraft = {
      ...draft,
      tiers: draft.tiers.filter((t) => t.key === 'common'),
      contents: draft.contents.map((c) => ({ ...c, tierKey: 'common' })),
    };

    await saveAt({ boxId, expectedVersion: 2, draft: edited, publish: false, userId: MOD });

    expect((await liveBox(boxId)).tiers).toEqual([{ key: 'common', name: 'Common', weight: 3 }]);
    expect((await snapshots(boxId)).at(-1)?.snapshot).toEqual(await liveBox(boxId));
  });

  it('refuses a save from an editor opened at an earlier version, and writes nothing', async () => {
    const { boxId, draft } = await publishedBox();

    await expect(
      saveAt({
        boxId,
        expectedVersion: 1,
        draft: { ...draft, name: 'Renamed' },
        publish: false,
        userId: MOD,
      })
    ).rejects.toBeInstanceOf(BoxRefusal);
    expect(await boxRow(boxId)).toMatchObject({ version: 2, name: 'Party Box' });
  });

  it("refuses a save from an editor opened before another moderator's detail-only save", async () => {
    const { boxId, draft } = await publishedBox();
    // Back-date the stamp so the rename below can't land in the same millisecond.
    await db.query(
      `UPDATE "ItemDefinition" SET "updatedAt" = "updatedAt" - interval '1 second' WHERE id = $1`,
      [boxId]
    );
    const [{ updatedAt: opened }] = await rows<{ updatedAt: Date }>(
      `SELECT "updatedAt" FROM "ItemDefinition" WHERE id = $1`,
      [boxId]
    );
    // Another moderator renames it; the version stays, the stamp moves.
    await saveAt({
      boxId,
      expectedVersion: 2,
      draft: { ...draft, name: 'Theirs' },
      publish: false,
      userId: MOD,
    });

    await expect(
      saveBox({
        boxId,
        expectedVersion: 2,
        expectedUpdatedAt: new Date(opened).toISOString(),
        draft: { ...draft, description: 'Mine' },
        publish: false,
        userId: MOD,
      })
    ).rejects.toBeInstanceOf(BoxRefusal);
    expect(await boxRow(boxId)).toMatchObject({ version: 2, name: 'Theirs' });
  });

  it('a name-only edit keeps the version: nothing caches box details under it', async () => {
    const { boxId, draft } = await publishedBox();

    const result = await saveAt({
      boxId,
      expectedVersion: 2,
      draft: { ...draft, name: 'Renamed' },
      publish: false,
      userId: MOD,
    });

    expect(result).toEqual({ version: 2, status: 'published', bumped: false });
    expect(await boxRow(boxId)).toMatchObject({ version: 2, name: 'Renamed' });
    expect((await snapshots(boxId)).map((s) => s.version)).toEqual([2]);
  });

  it('records a change made outside the builder as a new version with the same odds', async () => {
    const { boxId } = await publishedBox();

    expect(await recordOutsideChange({ boxId, expectedVersion: 2, userId: MOD })).toBe(3);
    const written = await snapshots(boxId);
    expect(written.map((s) => s.version)).toEqual([2, 3]);
    expect(written[1].snapshot).toEqual(V2_SNAPSHOT);
  });
});

// A save holds the lock every open waits on, so a large box must not have every row rewritten.
describe('a save writes only the tier and content rows it changes', () => {
  const countWrites = async () => {
    await db.exec(`
      CREATE TABLE "RowWrite" ("table" TEXT NOT NULL, "op" TEXT NOT NULL);
      CREATE FUNCTION record_row_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO "RowWrite" VALUES (TG_TABLE_NAME, TG_OP); RETURN NULL; END $$;
      CREATE TRIGGER box_tier_row_write AFTER INSERT OR UPDATE OR DELETE ON "BoxTier"
        FOR EACH ROW EXECUTE FUNCTION record_row_write();
      CREATE TRIGGER box_content_row_write AFTER INSERT OR UPDATE OR DELETE ON "BoxContent"
        FOR EACH ROW EXECUTE FUNCTION record_row_write();
    `);
    return () =>
      rows<{ table: string; op: string; n: number }>(
        `SELECT "table", op, count(*)::int AS n FROM "RowWrite" GROUP BY 1, 2 ORDER BY 1, 2`
      );
  };

  it('an unchanged save writes none', async () => {
    const { boxId, draft } = await publishedBox();
    const writes = await countWrites();

    await saveAt({ boxId, expectedVersion: 2, draft, publish: false, userId: MOD });

    expect(await writes()).toEqual([]);
  });

  it('a weight edit writes one tier row', async () => {
    const { boxId, draft } = await publishedBox();
    const writes = await countWrites();
    const edited = {
      ...draft,
      tiers: draft.tiers.map((t) => (t.key === 'rare' ? { ...t, weight: 2 } : t)),
    };

    await saveAt({ boxId, expectedVersion: 2, draft: edited, publish: false, userId: MOD });

    expect(await writes()).toEqual([{ table: 'BoxTier', op: 'UPDATE', n: 1 }]);
    expect((await liveBox(boxId)).tiers).toContainEqual({ key: 'rare', name: 'Rare', weight: 2 });
  });

  // A draft: the published checklist would refuse a tier left with nothing for one team.
  const draftBox = async () => {
    const boxId = await createBox({ name: 'Party Box', userId: MOD });
    const base = await partyDraft();
    await saveAt({ boxId, expectedVersion: 1, draft: base, publish: false, userId: MOD });
    return { boxId, draft: await savedDraft(boxId, base) };
  };
  const tierRows = (boxId: number) =>
    rows<{ key: string; name: string; color: string | null; sortOrder: number }>(
      `SELECT key, name, color, "sortOrder" FROM "BoxTier" WHERE "boxDefinitionId" = $1 ORDER BY key`,
      [boxId]
    );

  it.each([
    {
      field: 'colour',
      edit: (tiers: BoxDraft['tiers']) =>
        tiers.map((t) => (t.key === 'common' ? { ...t, color: null } : t)),
      written: 1,
      expected: [
        { key: 'common', name: 'Common', color: null, sortOrder: 0 },
        { key: 'rare', name: 'Rare', color: '#3b82f6', sortOrder: 1 },
      ],
    },
    {
      field: 'name',
      edit: (tiers: BoxDraft['tiers']) =>
        tiers.map((t) => (t.key === 'rare' ? { ...t, name: 'Legendary' } : t)),
      written: 1,
      expected: [
        { key: 'common', name: 'Common', color: '#9ca3af', sortOrder: 0 },
        { key: 'rare', name: 'Legendary', color: '#3b82f6', sortOrder: 1 },
      ],
    },
    {
      field: 'order',
      edit: (tiers: BoxDraft['tiers']) => [...tiers].reverse(),
      written: 2,
      expected: [
        { key: 'common', name: 'Common', color: '#9ca3af', sortOrder: 1 },
        { key: 'rare', name: 'Rare', color: '#3b82f6', sortOrder: 0 },
      ],
    },
  ])('a $field edit writes the tier rows it changes', async ({ edit, written, expected }) => {
    const { boxId, draft } = await draftBox();
    const writes = await countWrites();

    await saveAt({
      boxId,
      expectedVersion: 2,
      draft: { ...draft, tiers: edit(draft.tiers) },
      publish: false,
      userId: MOD,
    });

    expect(await writes()).toEqual([{ table: 'BoxTier', op: 'UPDATE', n: written }]);
    expect(await tierRows(boxId)).toEqual(expected);
  });

  it('a name that differs only by surrounding spaces writes none: the save trims it', async () => {
    const { boxId, draft } = await draftBox();
    const writes = await countWrites();
    const padded = { ...draft, tiers: draft.tiers.map((t) => ({ ...t, name: ` ${t.name} ` })) };

    await saveAt({ boxId, expectedVersion: 2, draft: padded, publish: false, userId: MOD });

    expect(await writes()).toEqual([]);
  });

  it('moving two contents between tiers writes those two content rows', async () => {
    const { boxId, draft } = await draftBox();
    const writes = await countWrites();
    const blueCap = await defOf(1);
    const blueCrown = await defOf(3);
    const edited = {
      ...draft,
      contents: draft.contents.map((c) =>
        c.rewardDefinitionId === blueCap
          ? { ...c, tierKey: 'rare' }
          : c.rewardDefinitionId === blueCrown
          ? { ...c, tierKey: 'common' }
          : c
      ),
    };

    await saveAt({ boxId, expectedVersion: 2, draft: edited, publish: false, userId: MOD });

    expect(await writes()).toEqual([{ table: 'BoxContent', op: 'UPDATE', n: 2 }]);
    expect(
      await rows(
        `SELECT d."cosmeticId", t.key FROM "BoxContent" c
         JOIN "BoxTier" t ON t.id = c."tierId"
         JOIN "ItemDefinition" d ON d.id = c."rewardDefinitionId"
         WHERE c."boxDefinitionId" = $1 ORDER BY d."cosmeticId"`,
        [boxId]
      )
    ).toEqual([
      { cosmeticId: 1, key: 'rare' },
      { cosmeticId: 2, key: 'common' },
      { cosmeticId: 3, key: 'common' },
      { cosmeticId: 4, key: 'rare' },
    ]);
  });

  it.each([
    { dropped: 'one content', keep: [1, 2, 3], deleted: 1 },
    { dropped: 'all but one content', keep: [1], deleted: 3 },
    { dropped: 'every content', keep: [], deleted: 4 },
  ])('$dropped dropped from the draft is deleted', async ({ keep, deleted }) => {
    const { boxId, draft } = await draftBox();
    const writes = await countWrites();
    const kept = await Promise.all(keep.map(defOf));
    const edited = {
      ...draft,
      contents: draft.contents.filter((c) => kept.includes(c.rewardDefinitionId)),
    };

    await saveAt({ boxId, expectedVersion: 2, draft: edited, publish: false, userId: MOD });

    expect(await writes()).toEqual([{ table: 'BoxContent', op: 'DELETE', n: deleted }]);
    expect(
      (
        await rows<{ cosmeticId: number }>(
          `SELECT d."cosmeticId" FROM "BoxContent" c
           JOIN "ItemDefinition" d ON d.id = c."rewardDefinitionId"
           WHERE c."boxDefinitionId" = $1 ORDER BY d."cosmeticId"`,
          [boxId]
        )
      ).map((row) => row.cosmeticId)
    ).toEqual(keep);
  });

  it('keeps a new tier saved with nothing in it', async () => {
    const { boxId, draft } = await draftBox();
    const writes = await countWrites();
    const edited = {
      ...draft,
      tiers: [...draft.tiers, { id: null, key: 'epic', name: 'Epic', weight: 1, color: null }],
    };

    await saveAt({ boxId, expectedVersion: 2, draft: edited, publish: false, userId: MOD });

    expect(await writes()).toEqual([{ table: 'BoxTier', op: 'INSERT', n: 1 }]);
    expect((await tierRows(boxId)).map((tier) => tier.key)).toEqual(['common', 'epic', 'rare']);
  });

  it('adds new tiers and contents in one save, beside rows it leaves alone', async () => {
    const { boxId, draft } = await publishedBox();
    const writes = await countWrites();
    const edited: BoxDraft = {
      ...draft,
      tiers: [...draft.tiers, { id: null, key: 'epic', name: 'Epic', weight: 1, color: null }],
      contents: [
        ...draft.contents,
        { id: null, rewardDefinitionId: await defOf(5), tierKey: 'epic', enabled: true },
      ],
    };

    await saveAt({ boxId, expectedVersion: 2, draft: edited, publish: false, userId: MOD });

    expect(await writes()).toEqual([
      { table: 'BoxContent', op: 'INSERT', n: 1 },
      { table: 'BoxTier', op: 'INSERT', n: 1 },
    ]);
    expect((await liveBox(boxId)).contents).toContainEqual({ tier: 'epic', cosmeticId: 5 });
  });

  it('refuses a draft that lists one content twice', async () => {
    const { boxId, draft } = await publishedBox();
    const twice = draft.contents[0];

    await expect(
      saveAt({
        boxId,
        expectedVersion: 2,
        draft: {
          ...draft,
          contents: [...draft.contents, { ...twice, enabled: !twice.enabled }],
        },
        publish: false,
        userId: MOD,
      })
    ).rejects.toThrow(`Content #${twice.id} is in the box twice.`);
  });
});

describe('a draft', () => {
  it('bumps on an odds change but writes no snapshot: nothing shows a draft', async () => {
    const boxId = await createBox({ name: 'Party Box', userId: MOD });

    const result = await saveAt({
      boxId,
      expectedVersion: 1,
      draft: await partyDraft(),
      publish: false,
      userId: MOD,
    });

    expect(result).toEqual({ version: 2, status: 'draft', bumped: true });
    expect(await snapshots(boxId)).toEqual([]);
    await expect(
      recordOutsideChange({ boxId, expectedVersion: 2, userId: MOD })
    ).rejects.toBeInstanceOf(BoxRefusal);
  });

  it('bumps when only the event changed: the event decides who can draw what', async () => {
    const boxId = await createBox({ name: 'Party Box', userId: MOD });
    const base = await partyDraft();
    await saveAt({ boxId, expectedVersion: 1, draft: base, publish: false, userId: MOD });
    const draft = await savedDraft(boxId, base);

    expect(await saveAt({ boxId, expectedVersion: 2, draft, publish: false, userId: MOD })).toEqual(
      { version: 2, status: 'draft', bumped: false }
    );
    expect(
      await saveAt({
        boxId,
        expectedVersion: 2,
        draft: { ...draft, event: '' },
        publish: false,
        userId: MOD,
      })
    ).toEqual({ version: 3, status: 'draft', bumped: true });
  });
});

describe('a box listing', () => {
  it('is created unlisted, which the CHECK requires', async () => {
    const { boxId } = await publishedBox();

    await createBoxListing({
      boxId,
      userId: MOD,
      listing: {
        title: 'Party Box',
        description: null,
        unitAmount: 500,
        availableFrom: null,
        availableTo: null,
        availableQuantity: null,
        status: 'Published',
      },
    });

    expect(
      await rows(`SELECT listed, "cosmeticId", "itemDefinitionId" FROM "CosmeticShopItem"`)
    ).toEqual([{ listed: false, cosmeticId: null, itemDefinitionId: boxId }]);
    // The CHECK is live in this schema: a box listing left at the column default is refused.
    await expect(
      db.query(
        `INSERT INTO "CosmeticShopItem" ("unitAmount", title, "itemDefinitionId") VALUES (1, 'x', $1)`,
        [boxId]
      )
    ).rejects.toThrow(/item_listing_unlisted_check/);
  });
});

const LISTING = {
  title: 'Party Box',
  description: null,
  unitAmount: 500,
  availableFrom: null,
  availableTo: null,
  availableQuantity: null,
  status: 'Draft' as const,
};

describe('editing a box listing', () => {
  // A moderator refund finds what a purchase bought through the listing's CURRENT itemDefinitionId,
  // so a listing re-pointed at another box would leave every earlier purchase unrefundable. Keep
  // this listing's box fixed by the WHERE, not by trusting the input.
  it('changes price and window but never the box it sells, nor `listed`', async () => {
    const { boxId } = await publishedBox();
    const other = await createBox({ name: 'Other Box', userId: MOD });
    const listingId = await createBoxListing({ boxId, userId: MOD, listing: LISTING });

    await updateBoxListing({ boxId, listingId, listing: { ...LISTING, unitAmount: 750 } });
    await expect(
      updateBoxListing({ boxId: other, listingId, listing: { ...LISTING, unitAmount: 1 } })
    ).rejects.toBeInstanceOf(BoxRefusal);

    expect(
      await rows(`SELECT "unitAmount", "itemDefinitionId", listed FROM "CosmeticShopItem"`)
    ).toEqual([{ unitAmount: 750, itemDefinitionId: boxId, listed: false }]);
  });
});

describe('cosmetic definitions', () => {
  it('makes one per cosmetic, and a second run makes none', async () => {
    // beforeEach made the five party definitions.
    expect(await createCosmeticDefinitions({ selector: { event: EVENT }, userId: MOD })).toEqual({
      created: 0,
      alreadyDefined: 5,
    });
    expect(
      await createCosmeticDefinitions({ selector: { cosmeticIds: [9, 1] }, userId: MOD })
    ).toEqual({ created: 1, alreadyDefined: 1 });
    expect(
      await rows(`SELECT count(*)::int AS n FROM "ItemDefinition" WHERE type = 'cosmetic'`)
    ).toEqual([{ n: 6 }]);
  });
});
