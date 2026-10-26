import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { Kysely } from 'kysely';
import type { ModelRuleHoldQuery } from '../model-rule-holds.queries';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const {
  countModelRuleHoldsByRule,
  countPendingModelRuleHolds,
  getModelRuleHoldHistory,
  getOwnerRuleHolds,
  listModelRuleHolds,
  modelRuleHoldSearch,
} = await import('../model-rule-holds.queries');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '20261016150000_text_scan_hold',
  '20261112120000_text_scan_hold_one_pending',
].map((name) =>
  readFileSync(
    join(
      HERE,
      `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf-8'
  )
);

const PENDING: ModelRuleHoldQuery = {
  status: 'pending',
  mode: 'all',
  sort: 'oldest',
  rule: null,
  limit: 10,
  offset: 0,
};

let db: PGlite;

const rule = (id: number, subject = `Subject ${id}`) => ({
  id,
  subject,
  description: `About ${id}`,
  aliases: [],
});
const meta = (extra: Record<string, unknown> = {}) => ({
  mode: 'shadow',
  fields: [{ heading: 'Name', text: 'Some model name' }],
  matches: [{ ruleId: 1, term: 'model', field: 'Name', fieldIndex: 0, start: 5, end: 10 }],
  rules: [rule(1)],
  ...extra,
});

type Seed = {
  id: number;
  entityId?: number;
  label?: string;
  status?: string;
  userId?: number | null;
  createdAt?: string;
  textHash?: string;
  hiddenAt?: string;
  restoredAt?: string;
  meta?: unknown;
  decidedById?: number;
  decidedAt?: string;
};

const seed = (rows: Seed[]) =>
  Promise.all(
    rows.map((r) =>
      db.query(
        `INSERT INTO "TextScanHold" ("id","entityType","entityId","label","textHash","status","userId",
           "text","reason","createdAt","updatedAt","meta","decidedById","decidedAt","hiddenAt","restoredAt")
         VALUES ($1,'Model',$2,$3,$4,$5::"TextScanHoldStatus",$6,'neutral text','neutral reason',$7,$7,$8::jsonb,
           $9,$10,$11,$12)`,
        [
          r.id,
          r.entityId ?? r.id * 10,
          r.label ?? 'modelRules',
          r.textHash ?? `h-${r.id}`,
          r.status ?? 'Pending',
          r.userId === undefined ? 10 : r.userId,
          r.createdAt ?? '2026-10-20T10:00:00Z',
          JSON.stringify(r.meta === undefined ? meta() : r.meta),
          r.decidedById ?? null,
          r.decidedAt ?? null,
          r.hiddenAt ?? null,
          r.restoredAt ?? null,
        ]
      )
    )
  );

const ids = (items: { id: number }[]) => items.map((i) => i.id);

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`CREATE TABLE "EntityModeration" ("id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'Succeeded', "result" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now())`);
  for (const migration of MIGRATIONS) await db.exec(migration);
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
    CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "status" TEXT NOT NULL,
      "userId" INTEGER, "type" TEXT NOT NULL DEFAULT 'LORA', "poi" BOOLEAN NOT NULL DEFAULT false,
      "minor" BOOLEAN NOT NULL DEFAULT false,
      "uploadType" TEXT NOT NULL DEFAULT 'Created',
      "availability" TEXT NOT NULL DEFAULT 'Public', "deletedAt" TIMESTAMP(3));
  `);
  await db.query(
    `INSERT INTO "User" ("id","username") VALUES (10,'owner_a'), (11,'Mod_Person'), (12,'owner_b')`
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  await (dbHandle.current as Kysely<unknown> | null)?.destroy();
  dbHandle.current = null;
  await db.close();
});

describe('listModelRuleHolds', () => {
  it('lists only pending model-rule holds by default, oldest first, without superseded ones', async () => {
    await seed([
      { id: 1, createdAt: '2026-10-21T10:00:00Z' },
      { id: 2, createdAt: '2026-10-20T10:00:00Z' },
      { id: 3, label: 'csam' },
      { id: 4, status: 'Dismissed', meta: meta({ decision: 'superseded' }) },
      { id: 5, status: 'Confirmed', decidedById: 11, decidedAt: '2026-10-21T00:00:00Z' },
    ]);
    const { items, hasMore } = await listModelRuleHolds(PENDING);
    expect(ids(items)).toEqual([2, 1]);
    expect(hasMore).toBe(false);
  });

  it('filters by status, mode and rule; a hold without a stored mode counts as Review', async () => {
    await seed([
      { id: 1, meta: meta({ mode: 'active' }), hiddenAt: '2026-10-20T10:00:00Z' },
      { id: 2, meta: { ...meta(), mode: undefined } },
      { id: 3, meta: meta({ rules: [rule(1), rule(2)] }) },
      { id: 4, status: 'Confirmed', decidedById: 11, decidedAt: '2026-10-21T00:00:00Z' },
      { id: 5, status: 'Dismissed', meta: meta({ decision: 'dismiss_allowed' }) },
    ]);
    expect(ids((await listModelRuleHolds({ ...PENDING, mode: 'auto' })).items)).toEqual([1]);
    expect(ids((await listModelRuleHolds({ ...PENDING, mode: 'review' })).items)).toEqual([2, 3]);
    expect(ids((await listModelRuleHolds({ ...PENDING, rule: 2 })).items)).toEqual([3]);
    expect(ids((await listModelRuleHolds({ ...PENDING, status: 'confirmed' })).items)).toEqual([4]);
    expect(ids((await listModelRuleHolds({ ...PENDING, status: 'dismissed' })).items)).toEqual([5]);
    expect(
      ids((await listModelRuleHolds({ ...PENDING, status: 'all', sort: 'newest' })).items)
    ).toEqual([5, 4, 3, 2, 1]);
  });

  it('searches by model id, owner id and username prefix', async () => {
    await seed([
      { id: 1, entityId: 555, userId: 10 },
      { id: 2, entityId: 556, userId: 12 },
    ]);
    const find = async (q: string) =>
      ids((await listModelRuleHolds({ ...PENDING, search: modelRuleHoldSearch(q) })).items);
    expect(await find('555')).toEqual([1]);
    expect(await find('12')).toEqual([2]);
    expect(await find('OWNER_a')).toEqual([1]);
    expect(await find('owner')).toEqual([1, 2]);
  });

  it('counts the owner’s other pending holds and flags edits since the scan', async () => {
    await seed([
      { id: 1, userId: 10, textHash: 'old' },
      { id: 2, userId: 10 },
      { id: 3, userId: 10, status: 'Dismissed', meta: meta({ decision: 'dismiss_allowed' }) },
      { id: 4, userId: 12, textHash: 'same' },
    ]);
    await db.exec(`INSERT INTO "EntityModeration" ("entityType","entityId","result") VALUES
      ('Model', 10, '{"textHash":"new"}'), ('Model:shadow', 40, '{"textHash":"same"}')`);
    const { items } = await listModelRuleHolds(PENDING);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(1)).toMatchObject({
      otherPendingByOwner: 1,
      otherHeldModels: 2,
      editedSince: true,
    });
    expect(byId.get(2)).toMatchObject({ otherPendingByOwner: 1, editedSince: false });
    expect(byId.get(4)).toMatchObject({ otherPendingByOwner: 0, editedSince: false });
  });

  it('narrows to one owner’s holds', async () => {
    await seed([
      { id: 1, userId: 10 },
      { id: 2, userId: 12 },
    ]);
    expect(ids((await listModelRuleHolds({ ...PENDING, owner: 12 })).items)).toEqual([2]);
    expect(await countModelRuleHoldsByRule({ status: 'pending', mode: 'all', owner: 12 })).toEqual([
      { id: 1, subject: 'Subject 1', count: 1 },
    ]);
  });

  it('parses the stored meta into the row', async () => {
    await seed([
      {
        id: 1,
        meta: meta({
          mode: 'active',
          kind: 'redetected',
          priorHoldId: 9,
          rules: [rule(1, 'Subject A'), rule(2, 'Subject B')],
        }),
        hiddenAt: '2026-10-20T10:00:00Z',
      },
    ]);
    const [row] = (await listModelRuleHolds(PENDING)).items;
    expect(row).toMatchObject({
      modelId: 10,
      username: 'owner_a',
      mode: 'active',
      applied: true,
      redetected: true,
      priorHoldId: 9,
    });
    expect(row.rules.map((r) => r.subject)).toEqual(['Subject A', 'Subject B']);
    expect(row.fields).toHaveLength(1);
  });

  it('says whether a ruling clears the rules instead of restoring the model', async () => {
    await seed([{ id: 1, meta: meta({ source: 'training' }) }, { id: 2 }, { id: 3 }]);
    await db.exec(`INSERT INTO "Model" ("id","name","status")
      VALUES (10,'Draft one','Draft'), (20,'Published one','Published'), (30,'Taken down','UnpublishedViolation')`);
    const byId = new Map((await listModelRuleHolds(PENDING)).items.map((i) => [i.id, i]));
    expect(byId.get(1)?.clearsRules).toBe(true);
    expect(byId.get(2)?.clearsRules).toBe(false);
    expect(byId.get(3)?.clearsRules).toBe(false);
  });

  it('says whether a training run raised the hold and whether the model was trained on Civitai', async () => {
    await seed([
      { id: 1, meta: meta({ source: 'training' }) },
      { id: 2, meta: meta({ source: 'elsewhere' }) },
      { id: 3 },
    ]);
    await db.exec(`INSERT INTO "Model" ("id","name","status","uploadType")
      VALUES (10,'Trained one','Draft','Trained'), (20,'Uploaded one','Draft','Created')`);
    const byId = new Map((await listModelRuleHolds(PENDING)).items.map((i) => [i.id, i]));
    expect(byId.get(1)).toMatchObject({ source: 'training', uploadType: 'Trained' });
    expect(byId.get(2)).toMatchObject({ source: null, uploadType: 'Created' });
    expect(byId.get(3)).toMatchObject({ source: null, uploadType: null });
  });

  it('pages with hasMore', async () => {
    await seed([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const page = await listModelRuleHolds({ ...PENDING, limit: 2 });
    expect(ids(page.items)).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
  });
});

describe('counts', () => {
  it('counts pending holds and groups them by rule under the current filters', async () => {
    await seed([
      { id: 1, meta: meta({ rules: [rule(1, 'A'), rule(2, 'B')] }) },
      { id: 2, meta: meta({ rules: [rule(2, 'B')], mode: 'active' }) },
      { id: 3, status: 'Confirmed', meta: meta({ rules: [rule(3, 'C')] }) },
    ]);
    expect(await countPendingModelRuleHolds()).toBe(2);
    const all = await countModelRuleHoldsByRule({ status: 'pending', mode: 'all' });
    expect(all).toEqual([
      { id: 2, subject: 'B', count: 2 },
      { id: 1, subject: 'A', count: 1 },
    ]);
    expect(await countModelRuleHoldsByRule({ status: 'pending', mode: 'auto' })).toEqual([
      { id: 2, subject: 'B', count: 1 },
    ]);
  });
});

describe('history and owner holds', () => {
  it('lists the earlier holds on a model, without superseded ones or the hold itself', async () => {
    await seed([
      {
        id: 1,
        entityId: 7,
        status: 'Dismissed',
        decidedById: 11,
        decidedAt: '2026-10-18T00:00:00Z',
        meta: meta({ decision: 'dismiss_allowed' }),
      },
      { id: 2, entityId: 7, status: 'Dismissed', meta: meta({ decision: 'superseded' }) },
      { id: 3, entityId: 7 },
      { id: 4, entityId: 8 },
    ]);
    const history = await getModelRuleHoldHistory(3);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: 1,
      status: 'Dismissed',
      decision: 'dismiss_allowed',
      decidedByUsername: 'Mod_Person',
    });
  });

  it('says per earlier hold whether its ruling cleared rules rather than restored the model', async () => {
    await seed([
      { id: 1, entityId: 7, status: 'Dismissed', meta: meta({ source: 'training' }) },
      { id: 2, entityId: 7, status: 'Dismissed', meta: meta({ decision: 'dismiss_allowed' }) },
      { id: 3, entityId: 7 },
    ]);
    await db.exec(
      `INSERT INTO "Model" ("id","name","status") VALUES (7,'Taken down','UnpublishedViolation')`
    );
    const byId = new Map((await getModelRuleHoldHistory(3)).map((e) => [e.id, e]));
    expect(byId.get(1)?.clearsRules).toBe(true);
    expect(byId.get(2)?.clearsRules).toBe(false);
  });

  it('lists the owner’s other pending holds with their hashes', async () => {
    await seed([
      { id: 1, entityId: 7, userId: 10 },
      { id: 2, entityId: 8, userId: 10, textHash: 'two' },
      {
        id: 3,
        entityId: 9,
        userId: 10,
        status: 'Confirmed',
        decidedById: 11,
        decidedAt: '2026-10-18T00:00:00Z',
      },
      { id: 4, entityId: 5, userId: 12 },
    ]);
    await db.exec(
      `INSERT INTO "Model" ("id","name","status","userId") VALUES (8,'Other model','Published',10)`
    );
    const owner = await getOwnerRuleHolds(1);
    expect(owner?.userId).toBe(10);
    expect(owner?.pending).toEqual([
      { id: 2, modelId: 8, modelName: 'Other model', textHash: 'two' },
    ]);
  });

  it('returns null for a hold without an owner', async () => {
    await seed([{ id: 1, userId: null }]);
    expect(await getOwnerRuleHolds(1)).toBeNull();
  });
});
