import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStore,
  createDocStoreMaintenance,
  type DocStore,
  type DocStoreMaintenance,
} from '~/server/services/apps/doc-store';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import type { MigrationMutationOp } from '~/server/services/apps/storage-schema-migrations';
import { applyMigrationOps } from '~/server/services/apps/storage-schema-migrations';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { assertUsageConsistent, ctx, decl, freshApp, NS_PROD } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * App Storage schema migrations — the store operation (`DocStoreMaintenance.migrateDocuments`)
 * against the real migration on PGlite with row-level security ON, as `appdata_rw`. Every
 * statement it sends is also checked by the harness's runtime isolation recorder.
 *
 * Expected values are literals; usage is cross-checked against a recompute from the documents
 * (`assertUsageConsistent`), a different mechanism from the incremental charge under test.
 */

// Pairwise-distinct viewers, distinct from every literal below.
const ALICE = 3101;
const BOB = 3202;
const DEV = 3303;

const OPS: MigrationMutationOp[] = [
  { op: 'default', path: '/status', value: 'draft' },
  { op: 'rename', from: '/name', to: '/title' },
  { op: 'remove', path: '/legacy' },
];
/** The transform the run hands the store: the ops, under the collection's NEW schema. */
const transformFor = (coll: DocCollection) => (data: Record<string, unknown>) =>
  applyMigrationOps(data, OPS, coll.config.schema);

const CARDS: DocCollection = {
  name: 'cards',
  config: decl({
    visibility: 'private',
    indexes: { status: 'string' },
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { enum: ['draft', 'live'] }, title: { type: 'string' } },
    },
  }),
};
const BOARD: DocCollection = {
  name: 'board',
  config: decl({ visibility: 'shared', write: 'own' }),
};
/** BOARD under its new schema, which no longer allows `legacy`. */
const BOARD_V2: DocCollection = {
  name: 'board',
  config: decl({
    visibility: 'shared',
    write: 'own',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' }, title: { type: 'string' } },
    },
  }),
};
/** `stars` narrowed (string → integer ≤ 5) and kept optional; `remove /stars` covers it. */
const STARS_V1: DocCollection = { name: 'stars', config: decl({ visibility: 'private' }) };
const STARS_V2: DocCollection = {
  name: 'stars',
  config: decl({
    visibility: 'private',
    schema: { type: 'object', properties: { stars: { type: 'integer', maximum: 5 } } },
  }),
};
const REMOVE_STARS: MigrationMutationOp[] = [{ op: 'remove', path: '/stars' }];
/** The declarations the documents were written under (before the migration). */
const CARDS_V1: DocCollection = {
  name: 'cards',
  config: decl({ visibility: 'private', indexes: { status: 'string' } }),
};

let h: Harness;
let store: DocStore;
let maint: DocStoreMaintenance;

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
  store = createDocStore({ db: h.db });
  maint = createDocStoreMaintenance({ db: h.db });
});
afterAll(async () => {
  await h?.close();
});

/** The most pages {@link runAll} reads before failing: far above any fixture here. */
const MAX_PAGES = 1000;

/** Every page, until the cursor runs out; the summed counts. */
async function runAll(app: string, coll: DocCollection, limit: number) {
  const total = { scanned: 0, migrated: 0, unchanged: 0, failed: 0, invalid: 0, pages: 0 };
  let after = null;
  for (;;) {
    const r = await maint.migrateDocuments(app, coll, transformFor(coll), { after, limit });
    total.scanned += r.scanned;
    total.migrated += r.migrated;
    total.unchanged += r.unchanged;
    total.failed += r.failed;
    total.invalid += r.invalid;
    total.pages += 1;
    if (r.next === null) return total;
    // A cursor that never reaches the end (a regression in the keyset) fails here, not by timeout.
    expect(total.pages).toBeLessThan(MAX_PAGES);
    after = r.next;
  }
}

describe('migrateDocuments', () => {
  it('migrates every key space of a private collection, re-derives indexes, bumps versions, keeps usage exact — and a second run changes nothing', async () => {
    const app = freshApp('MIGRATE');
    await store.put(ctx(app, NS_PROD, ALICE), CARDS_V1, 'a1', { name: 'one', legacy: 1 });
    await store.put(ctx(app, NS_PROD, ALICE), CARDS_V1, 'a2', { status: 'live', title: 'two' });
    await store.put(ctx(app, NS_PROD, BOB), CARDS_V1, 'b1', { name: 'three' });
    // A dev namespace is test data: never migrated.
    await store.put(ctx(app, `dev:${DEV}`, DEV), CARDS_V1, 'd1', { name: 'dev', legacy: 2 });

    // Page size 2 over 3 documents in two key spaces: the cursor crosses a scope boundary.
    const first = await runAll(app, CARDS, 2);
    expect(first).toEqual({
      scanned: 3,
      migrated: 2,
      unchanged: 1,
      failed: 0,
      invalid: 0,
      pages: 2,
    });

    const a1 = await store.get(ctx(app, NS_PROD, ALICE), CARDS, 'a1');
    expect([a1?.data, a1?.version]).toEqual([{ status: 'draft', title: 'one' }, 2]);
    const a2 = await store.get(ctx(app, NS_PROD, ALICE), CARDS, 'a2');
    expect([a2?.data, a2?.version]).toEqual([{ status: 'live', title: 'two' }, 1]);
    const b1 = await store.get(ctx(app, NS_PROD, BOB), CARDS, 'b1');
    expect([b1?.data, b1?.version]).toEqual([{ status: 'draft', title: 'three' }, 2]);
    // The index row follows the migrated value.
    const drafts = await store.list(ctx(app, NS_PROD, ALICE), CARDS, {
      where: { status: 'draft' },
    });
    expect(drafts.items.map((d) => d.key)).toEqual(['a1']);

    const dev = await store.get(ctx(app, `dev:${DEV}`, DEV), CARDS_V1, 'd1');
    expect([dev?.data, dev?.version]).toEqual([{ name: 'dev', legacy: 2 }, 1]);

    await assertUsageConsistent(h, app, NS_PROD);

    // Idempotent: the same ops over the migrated documents change nothing.
    const second = await runAll(app, CARDS, 2);
    expect(second).toEqual({
      scanned: 3,
      migrated: 0,
      unchanged: 3,
      failed: 0,
      invalid: 0,
      pages: 2,
    });
    expect((await store.get(ctx(app, NS_PROD, ALICE), CARDS, 'a1'))?.version).toBe(2);
    expect(h.violations).toEqual([]);
  });

  it("charges a shared document's delta to its author and the app", async () => {
    const app = freshApp('MIGRATESHARED');
    await store.put(ctx(app, NS_PROD, ALICE), BOARD, 'p1', {
      name: 'post',
      legacy: 'x'.repeat(1000),
    });
    const before = await store.usage(ctx(app, NS_PROD, ALICE));
    const r = await maint.migrateDocuments(app, BOARD_V2, transformFor(BOARD_V2), { limit: 10 });
    expect([r.migrated, r.failed, r.next]).toEqual([1, 0, null]);
    const after = await store.usage(ctx(app, NS_PROD, ALICE));
    // The removed 1000-character field is refunded to both ceilings, by the same amount.
    expect(before.app.bytes - after.app.bytes).toBeGreaterThan(900);
    expect(before.viewer!.bytes - after.viewer!.bytes).toBe(before.app.bytes - after.app.bytes);
    await assertUsageConsistent(h, app, NS_PROD);
    const p1 = await store.get(ctx(app, NS_PROD, BOB), BOARD, 'p1');
    expect([p1?.data, p1?.author]).toEqual([
      { status: 'draft', title: 'post' },
      // The author is kept: a migration is not a write by anyone.
      { kind: 'user', uid: ALICE, isViewer: false },
    ]);
  });

  it('a rewrite the store refuses is counted as failed and leaves the document as it was', async () => {
    const app = freshApp('MIGRATEFAIL');
    await store.put(ctx(app, NS_PROD, ALICE), CARDS_V1, 'big', { name: 'x' });
    const tooLarge = () => ({ status: 'draft', title: 'y'.repeat(70_000) });
    const r = await maint.migrateDocuments(app, CARDS, tooLarge, { limit: 10 });
    expect([r.scanned, r.migrated, r.failed, r.failures]).toEqual([
      1,
      0,
      1,
      [{ scopeUid: ALICE, key: 'big', code: 'too_large' }],
    ]);
    const doc = await store.get(ctx(app, NS_PROD, ALICE), CARDS_V1, 'big');
    expect([doc?.data, doc?.version]).toEqual([{ name: 'x' }, 1]);
    await assertUsageConsistent(h, app, NS_PROD);
  });

  it('counts the documents that still do not match the schema afterwards (an acknowledged narrowing)', async () => {
    const app = freshApp('MIGRATEINVALID');
    await store.put(ctx(app, NS_PROD, ALICE), CARDS_V1, 'odd', { status: 'archived' });
    const r = await maint.migrateDocuments(app, CARDS, transformFor(CARDS), { limit: 10 });
    expect([r.scanned, r.migrated, r.unchanged, r.invalid]).toEqual([1, 0, 1, 1]);
  });

  it('🔴 RACE: a valid value written under the new schema between two pages survives the run', async () => {
    const app = freshApp('MIGRATERACE');
    const me = ctx(app, NS_PROD, ALICE);
    await store.put(me, STARS_V1, 'a', { stars: 'four' });
    await store.put(me, STARS_V1, 'b', { stars: 'nine' });
    const transform = (data: Record<string, unknown>) =>
      applyMigrationOps(data, REMOVE_STARS, STARS_V2.config.schema);

    // Page 1 reaches `a` only.
    const first = await maint.migrateDocuments(app, STARS_V2, transform, { limit: 1 });
    expect([first.migrated, first.next]).toEqual([1, { scopeUid: ALICE, key: 'a' }]);

    // The new build writes `b` under the new schema before the cursor gets there.
    await store.put(me, STARS_V2, 'b', { stars: 4 });

    const second = await maint.migrateDocuments(app, STARS_V2, transform, {
      after: first.next,
      limit: 1,
    });
    expect([second.scanned, second.migrated, second.unchanged]).toEqual([1, 0, 1]);
    expect((await store.get(me, STARS_V2, 'a'))?.data).toEqual({});
    const b = await store.get(me, STARS_V2, 'b');
    expect([b?.data, b?.version]).toEqual([{ stars: 4 }, 2]);
    await assertUsageConsistent(h, app, NS_PROD);
  });
});
