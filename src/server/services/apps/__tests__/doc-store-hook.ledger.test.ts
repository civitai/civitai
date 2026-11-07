import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  createDocStore,
  createDocStoreFeed,
  createDocStoreLookup,
  createDocStoreMaintenance,
  createDocStoreModeration,
  createDocStoreViewerData,
} from '~/server/services/apps/doc-store';
import { mintHookPass } from '~/server/services/apps/doc-store-hook-pass';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';

/**
 * 🔴 THE STORE-WRITE LEDGER for App Storage permission hooks.
 *
 * A hook is only a guarantee if NO write reaches a hooked collection around it. Two halves:
 *
 *   1. STRUCTURE. Every entry point of every store facet is classified below. A new method on
 *      any facet fails this test until it is classified, and a method classified `hooked` must
 *      refuse a write to a hooked collection without a HookPass (half 2 runs every one of them).
 *      `exempt` writers are platform operations, never a viewer's write: moderation, account and
 *      app deletion, the viewer's own "empty my data", review cleanup and declarative schema
 *      migrations. The production importers of the viewer store and of `mintHookPass` are listed
 *      too, so a new caller is a deliberate edit of this file.
 *   2. BEHAVIOUR. On a store with no database, a write that passes the hook check goes on to the
 *      transaction and is answered `storage_disabled`, and one that does not throws the HookPass
 *      error first. So each hooked method is shown to refuse without a pass (and with a forged or
 *      mismatched one), and to go through with a live pass for exactly that write and with no hook
 *      at all (the positive controls).
 */

const LEDGER = {
  store: {
    get: 'read',
    getMany: 'read',
    list: 'read',
    usage: 'read',
    limits: 'value',
    isUsable: 'read',
    put: 'hooked',
    create: 'hooked',
    delete: 'hooked',
    increment: 'hooked',
    mark: 'hooked',
    unmark: 'hooked',
  },
  moderation: {
    listReported: 'read',
    get: 'read',
    setHidden: 'exempt',
    dismissReports: 'exempt',
    delete: 'exempt',
  },
  maintenance: {
    purgeReview: 'exempt',
    listReviewAppIds: 'read',
    wipeAccount: 'exempt',
    purgeApp: 'exempt',
    migrateDocuments: 'exempt',
  },
  lookup: { findSharedByKey: 'read' },
  feed: { feedHead: 'read', feedChanges: 'read', feedDocuments: 'read', feedWitness: 'read' },
  viewerData: {
    listViewerUsage: 'read',
    viewerHoldings: 'read',
    emptyViewerData: 'exempt',
    limits: 'value',
  },
} as const;

const FACETS = {
  store: createDocStore({ db: null }),
  moderation: createDocStoreModeration({ db: null }),
  maintenance: createDocStoreMaintenance({ db: null }),
  lookup: createDocStoreLookup({ db: null }),
  feed: createDocStoreFeed({ db: null }),
  viewerData: createDocStoreViewerData({ db: null }),
};

const SRC = path.resolve(__dirname, '../../../..');
function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      productionFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}
const rel = (f: string) => path.relative(path.resolve(SRC, '..'), f).split(path.sep).join('/');
const filesMatching = (re: RegExp) =>
  productionFiles(SRC)
    .filter((f) => re.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();

describe('every store entry point is classified', () => {
  it.each(Object.keys(LEDGER) as (keyof typeof LEDGER)[])('%s', (facet) => {
    expect(Object.keys(FACETS[facet]).sort()).toEqual(Object.keys(LEDGER[facet]).sort());
  });

  it('only the hook gate mints a HookPass', () => {
    // Positive control for the scan: the pass module itself matches.
    expect(filesMatching(/\bmintHookPass\b/)).toEqual([
      'src/server/services/apps/doc-store-hook-pass.ts',
      'src/server/services/apps/doc-store-hook.ts',
    ]);
  });

  // Who holds the VIEWER store (the facet with the hooked writes). The two usage services read
  // `usage` and `limits` only; the route is the one writer, through the hook gate.
  it('the viewer store is obtained only where it is today', () => {
    expect(filesMatching(/\bgetDocStore\b|\bcreateDocStore\(/)).toEqual([
      'src/server/services/apps/doc-store-api.ts',
      'src/server/services/apps/doc-store-owner-usage.service.ts',
      'src/server/services/apps/doc-store-viewer-usage.service.ts',
      'src/server/services/apps/doc-store.instance.ts',
      'src/server/services/apps/doc-store.ts',
    ]);
  });
});

describe('a hooked collection refuses every hooked write without a HookPass', () => {
  const ctx: DocStoreContext = { appId: 'apb_ledger', ns: 'prod', viewerUid: 4242 };
  const decl = {
    visibility: 'shared',
    write: 'own',
    counters: ['likes'],
    marks: ['star'],
    indexes: new Map(),
    showAuthor: false,
  };
  const HOOK = { file: 'hooks/h.js', sha256: 'a'.repeat(64), timeoutMs: 50 };
  const hooked = { name: 'cards', config: { ...decl, hook: HOOK } } as unknown as DocCollection;
  const plain = { name: 'cards', config: decl } as unknown as DocCollection;
  const store = FACETS.store;
  const data = { title: 't' };
  const KEY = 'k1';

  type Op = 'create' | 'put' | 'delete' | 'increment' | 'mark' | 'unmark';
  const write = (op: Op, coll: DocCollection, hookPass?: unknown) => {
    const opts = { hookPass } as { hookPass: never };
    switch (op) {
      case 'create':
        return store.create(ctx, coll, data, { key: KEY, ...opts });
      case 'put':
        return store.put(ctx, coll, KEY, data, opts);
      case 'delete':
        return store.delete(ctx, coll, KEY, opts);
      case 'increment':
        return store.increment(ctx, coll, KEY, 'likes', 1, opts);
      case 'mark':
        return store.mark(ctx, coll, KEY, 'star', opts);
      case 'unmark':
        return store.unmark(ctx, coll, KEY, 'star', opts);
    }
  };
  const HOOKED = Object.entries(LEDGER.store)
    .filter(([, v]) => v === 'hooked')
    .map(([k]) => k);
  const OPS: Op[] = ['create', 'put', 'delete', 'increment', 'mark', 'unmark'];
  const passFor = (op: Op, over: Partial<{ key: string; op: Op; ns: string }> = {}) =>
    mintHookPass({
      appId: ctx.appId,
      ns: over.ns ?? ctx.ns,
      collection: 'cards',
      key: over.key ?? KEY,
      op: over.op ?? op,
      version: 0,
    });
  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'landed';
    } catch (err) {
      if (isDocStoreError(err, 'storage_disabled')) return 'reached the transaction';
      return err instanceof Error ? err.message : String(err);
    }
  };

  it('the ops below are exactly the hooked store methods', () => {
    expect([...OPS].sort()).toEqual([...HOOKED].sort());
  });

  it.each(OPS)('%s: no pass → refused before any transaction', async (op) => {
    expect(await outcome(write(op, hooked))).toBe(
      `doc-store: ${op} on cards has a permission hook and needs a HookPass`
    );
  });

  it.each(OPS)('%s: a forged pass (an object of the same shape) → refused', async (op) => {
    const forged = { ...passFor(op) };
    expect(await outcome(write(op, hooked, forged))).toBe(
      `doc-store: ${op} on cards has a permission hook and needs a HookPass`
    );
  });

  it.each(OPS)('%s: a pass for another key, op or namespace → refused', async (op) => {
    const other: Op = op === 'put' ? 'delete' : 'put';
    for (const pass of [
      passFor(op, { key: 'k2' }),
      passFor(op, { op: other }),
      passFor(op, { ns: 'dev:4242' }),
    ]) {
      expect(await outcome(write(op, hooked, pass))).toBe(
        `doc-store: the HookPass does not cover this ${op}`
      );
    }
  });

  it.each(OPS)(
    '%s: positive controls — a live pass, or no hook, reach the transaction',
    async (op) => {
      expect(await outcome(write(op, hooked, passFor(op)))).toBe('reached the transaction');
      expect(await outcome(write(op, plain))).toBe('reached the transaction');
    }
  );

  it('a pass is spent by the write that accepts it', async () => {
    const pass = passFor('put');
    expect(await outcome(write('put', hooked, pass))).toBe('reached the transaction');
    expect(await outcome(write('put', hooked, pass))).toBe(
      'doc-store: put on cards has a permission hook and needs a HookPass'
    );
  });

  it('the report mark is exempt: no pass needed on a hooked collection', async () => {
    expect(await outcome(store.mark(ctx, hooked, KEY, 'report'))).toBe('reached the transaction');
  });
});
