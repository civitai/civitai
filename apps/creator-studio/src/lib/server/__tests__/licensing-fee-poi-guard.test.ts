import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '../membership';

// Kysely fake, per table. `rows` is what the owned-versions read returns; `written` records every
// `.set()` so a test can assert the write never happened — a guard that returns 400 after writing would
// otherwise pass. `slots` records PricingSlot inserts, and `slotsUsed` drives the allowance count.
const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  written: [] as Record<string, unknown>[],
  slots: [] as Record<string, unknown>[],
  slotsUsed: 0,
  modelsScore: 50_000,
}));

vi.mock('$lib/server/db', () => {
  // 🔴 `then` must resolve to undefined. A catch-all proxy makes every chain object thenable, so
  // `await` on one calls a no-op `then` that never settles — the query does not fail, the test hangs
  // until the runner kills it. Returning undefined keeps an unhandled terminal an ordinary TypeError.
  const chain = (terminals: Record<string, unknown>): unknown =>
    new Proxy(terminals, {
      get: (t, prop: string) => {
        if (prop === 'then') return undefined;
        return t[prop] ?? (() => chain(t));
      },
    });

  const selectFrom = (table: string) => {
    if (table.startsWith('ModelVersion'))
      return chain({
        // Two reads hit this table with different aliases — ownedVersions selects `currentFee`,
        // unpricedVersionIds selects `fee` + `gated` — so serve both projections off one fixture.
        execute: async () =>
          state.rows.map((r) => ({ ...r, fee: r.currentFee, gated: r.gated ?? null })),
      });
    if (table === 'User')
      return chain({
        executeTakeFirst: async () => ({ meta: { scores: { models: state.modelsScore } } }),
      });
    if (table === 'PricingSlot')
      return chain({ executeTakeFirst: async () => ({ count: String(state.slotsUsed) }) });
    throw new Error(`unstubbed table in select: ${table}`);
  };

  const update: Record<string, unknown> = {};
  update.set = (values: Record<string, unknown>) => {
    state.written.push(values);
    return chain(update);
  };
  update.executeTakeFirst = async () => ({ numUpdatedRows: BigInt(state.rows.length) });
  update.execute = async () => [];

  const insertInto = (table: string) => {
    if (table !== 'PricingSlot') throw new Error(`unstubbed table in insert: ${table}`);
    const insert: Record<string, unknown> = {};
    insert.values = (values: Record<string, unknown>[]) => {
      state.slots.push(...values);
      return chain(insert);
    };
    insert.execute = async () => [];
    return chain(insert);
  };

  const db = {
    selectFrom,
    updateTable: () => chain(update),
    insertInto,
    transaction: () => ({ execute: async (cb: (trx: unknown) => unknown) => cb(db) }),
  };
  return { dbRead: db, dbWrite: db };
});

const { setLicensingFee, bulkSetLicensingFee } = await import('../monetization/licensing-fee');

const GOLD: Membership = { tier: 'gold', isMember: true, isCreatorProgramMember: true };

// `gated` stands in for a permanent PaidAccess row on the version (null = none).
const version = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  baseModel: 'SDXL 1.0',
  modelType: 'Checkpoint',
  currentFee: null,
  gated: null,
  meta: null,
  poi: false,
  ...over,
});

beforeEach(() => {
  state.rows = [];
  state.written = [];
  state.slots = [];
  state.slotsUsed = 0;
  state.modelsScore = 50_000;
});

// Creator Studio writes `licensingFee` with its own SQL and never reaches the main app, so the POI rule
// #3903 enforces there has to be re-applied here or this spoke is a way around it. The non-POI cases are
// the positive control: they prove the refusal is attributable to `poi` rather than to ownership or a
// missing rights affirmation, which refuse through this same return shape.
describe('licensing fee POI guard', () => {
  it('refuses a fee on a version whose model depicts a real person', async () => {
    state.rows = [version({ poi: true })];

    const result = await setLicensingFee(7, GOLD, 1, 1, true);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining('real person'),
    });
    expect(state.written).toEqual([]);
  });

  it('allows the same fee when the model is not POI', async () => {
    state.rows = [version()];

    const result = await setLicensingFee(7, GOLD, 1, 1, true);

    expect(result).toEqual({ ok: true });
    expect(state.written[0]).toMatchObject({ licensingFee: '1.00' });
  });

  it('refuses a bulk fee when any selected version is POI', async () => {
    state.rows = [version(), version({ id: 2, poi: true })];

    const result = await bulkSetLicensingFee(7, GOLD, [1, 2], 1, true);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining('depict a real person'),
    });
    expect(state.written).toEqual([]);
  });

  it('allows the same bulk fee when no selected version is POI', async () => {
    state.rows = [version(), version({ id: 2 })];

    const result = await bulkSetLicensingFee(7, GOLD, [1, 2], 1, true);

    expect(result).toMatchObject({ ok: true, updated: 2 });
    expect(state.written[0]).toMatchObject({ licensingFee: '1.00' });
  });
});

// The eligibility floor and the monthly allowance are enforced in the main app's service layer, which
// these direct-SQL writes never reach — so they are re-applied here, and this is what pins that. Without
// them Creator Studio is a way around both, exactly as it would be for the POI rule above.
describe('eligibility floor and monthly allowance', () => {
  it('refuses a first fee from a creator below the score floor, and writes nothing', async () => {
    state.rows = [version()];
    state.modelsScore = 9_999;

    const result = await setLicensingFee(7, GOLD, 1, 1, true);

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(state.written).toEqual([]);
    expect(state.slots).toEqual([]);
  });

  it('lets a below-floor creator change a fee they already charge', async () => {
    state.rows = [version({ currentFee: 2 })];
    state.modelsScore = 0;

    const result = await setLicensingFee(7, GOLD, 1, 5, true);

    expect(result).toEqual({ ok: true });
    expect(state.written[0]).toMatchObject({ licensingFee: '5.00' });
    expect(state.slots).toEqual([]);
  });

  // Already sells through a permanent gate, so it is exempt from both rules.
  it('treats a version with a permanent gate and no fee as already priced', async () => {
    state.rows = [version({ gated: 1 })];
    state.modelsScore = 0;
    state.slotsUsed = 3;

    const result = await setLicensingFee(7, GOLD, 1, 1, true);

    expect(result).toEqual({ ok: true });
    expect(state.written[0]).toMatchObject({ licensingFee: '1.00' });
    expect(state.slots).toEqual([]);
  });

  it('spends one slot when a version gains its first fee', async () => {
    state.rows = [version()];

    await setLicensingFee(7, GOLD, 1, 1, true);

    expect(state.slots).toEqual([{ entityType: 'ModelVersion', entityId: 1, ownerId: 7 }]);
  });

  it('refuses once the month is spent, counting only the newly priced versions', async () => {
    state.rows = [version(), version({ id: 2 })];
    state.slotsUsed = 2;
    const FREE: Membership = { tier: null, isMember: false, isCreatorProgramMember: false };

    const result = await bulkSetLicensingFee(7, FREE, [1, 2], 1, true);

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(state.written).toEqual([]);
  });

  // A bulk re-price of models the creator already charges for is free, however large the selection and
  // however full the month.
  it('allows a bulk re-price at a full allowance when every version is already priced', async () => {
    state.rows = [version({ currentFee: 1 }), version({ id: 2, currentFee: 1 })];
    state.slotsUsed = 3;
    const FREE: Membership = { tier: null, isMember: false, isCreatorProgramMember: false };

    const result = await bulkSetLicensingFee(7, FREE, [1, 2], 5, true);

    expect(result).toMatchObject({ ok: true, updated: 2 });
    expect(state.slots).toEqual([]);
  });
});
