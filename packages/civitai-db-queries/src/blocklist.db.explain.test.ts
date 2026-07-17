import { afterAll, describe, expect, it } from 'vitest';
import {
  getBlocklist,
  getBlocklistData,
  removeBlocklistItems,
  upsertBlocklist,
} from './blocklist.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. The query functions still
// run against the DummyDriver (never executing a write), and only the captured compiled SQL is EXPLAINed —
// which parses + plans it, so a column/type mismatch against the real `Blocklist` table fails here. Skips when
// no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('blocklist queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getBlocklist plans against the real schema', async () => {
    await getBlocklist(h.db, { type: 'email' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getBlocklistData plans against the real schema', async () => {
    await getBlocklistData(h.db, { type: 'linkDomain' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertBlocklist insert path plans (write, not executed)', async () => {
    await upsertBlocklist(h.db, { type: 'email', blocklist: ['foo'] }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertBlocklist update path plans both the read and the merge update', async () => {
    h.queries.length = 0; // explainAll plans every captured query — isolate this call's two statements
    await upsertBlocklist(h.db, { id: -1, type: 'email', blocklist: ['foo'] }).catch(() => {});
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('removeBlocklistItems read plans (row absent → no update)', async () => {
    await removeBlocklistItems(h.db, { id: -1, items: ['foo'] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
