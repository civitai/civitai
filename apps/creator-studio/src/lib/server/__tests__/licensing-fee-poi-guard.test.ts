import { beforeEach, describe, expect, it, vi } from 'vitest';
import { maxLicensingFeeCeiling } from '@civitai/buzz';
import type { Membership } from '../membership';

// Kysely fake, per table. `rows` is what the owned-versions read returns; `written` records every
// `.set()` so a test can assert the write never happened — a guard that returns 400 after writing would
// otherwise pass. `slots` records PricingSlot inserts, and `slotsUsed` drives the allowance count.
const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  written: [] as Record<string, unknown>[],
  slots: [] as Record<string, unknown>[],
  released: [] as number[][],
  releaseFilters: [] as string[],
  slotsUsed: 0,
  modelsScore: 50_000,
  // modelVersionId -> the last licenseFee charge ClickHouse reports for it.
  charges: {} as Record<number, string>,
  chargeQueries: [] as string[],
  clickhouseDown: false,
}));

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      state.chargeQueries.push(sql);
      if (state.clickhouseDown) throw new Error('clickhouse down');
      return Object.entries(state.charges).map(([modelVersionId, last]) => ({
        modelVersionId: Number(modelVersionId),
        last,
      }));
    },
  }),
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
        // Three reads hit this table with different aliases — ownedVersions selects `currentFee`,
        // unpricedVersionIds selects `fee` + `gated`, releasableVersionIds adds the transaction
        // signals — so serve every projection off one fixture.
        execute: async () =>
          state.rows.map((r) => ({
            initialPublishedAt: null,
            publishedAt: null,
            earned: 0,
            sold: false,
            slotCreatedAt: new Date('2026-08-20T00:00:00.000Z'),
            ...r,
            fee: r.currentFee,
            gated: r.gated ?? null,
          })),
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
    // Applied to the fixture, not just recorded: releasableVersionIds reads the version back after the
    // write, and a fake that never moves would show it still priced and never release anything.
    if ('licensingFee' in values)
      for (const row of state.rows) row.currentFee = values.licensingFee;
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

  const deleteFrom = (table: string) => {
    if (table !== 'PricingSlot') throw new Error(`unstubbed table in delete: ${table}`);
    const del: Record<string, unknown> = {};
    del.where = (column: string, op: string, value: unknown) => {
      if (column === 'entityId') state.released.push(value as number[]);
      state.releaseFilters.push(column);
      return chain(del);
    };
    del.execute = async () => [];
    return chain(del);
  };

  const db = {
    selectFrom,
    updateTable: () => chain(update),
    insertInto,
    deleteFrom,
    transaction: () => ({ execute: async (cb: (trx: unknown) => unknown) => cb(db) }),
  };
  return { dbRead: db, dbWrite: db };
});

const { setLicensingFee, bulkSetLicensingFee } = await import('../monetization/licensing-fee');

const GOLD: Membership = { tier: 'gold', isMember: true, isCreatorProgramMember: true };

const MAX_IMAGE_FEE = maxLicensingFeeCeiling('image');

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
  state.released = [];
  state.releaseFilters = [];
  state.charges = {};
  state.chargeQueries = [];
  state.clickhouseDown = false;
  state.slotsUsed = 0;
  state.modelsScore = 50_000;
});

// Clearing a price hands the slot back, but only when nothing has transacted against the version — the
// creator who priced a draft to see what it looked like should not pay a month's allowance for it.
// The spoke writes licensingFee with its own SQL, so the ceiling has to be re-applied here or this is
// a way around it — the same shape as the POI guard above, and it had no test at all until Justin's
// review pointed that out.
describe('licensing fee ceiling', () => {
  it('refuses a fee over the ceiling for the version media type, and writes nothing', async () => {
    state.rows = [version({ baseModel: 'SDXL 1.0' })];

    const result = await setLicensingFee(7, GOLD, 1, MAX_IMAGE_FEE + 1, true);

    expect(result.ok).toBe(false);
    expect(state.written).toEqual([]);
  });

  it('allows exactly the ceiling', async () => {
    state.rows = [version({ baseModel: 'SDXL 1.0' })];

    const result = await setLicensingFee(7, GOLD, 1, MAX_IMAGE_FEE, true);

    expect(result.ok).toBe(true);
  });

  // Video earns a higher ceiling, so the same number that is refused above is allowed here — without
  // this the test above passes for a ceiling that ignores the media axis entirely.
  it('applies the VIDEO ceiling to a video base model', async () => {
    state.rows = [version({ baseModel: 'Hunyuan Video' })];

    const result = await setLicensingFee(7, GOLD, 1, MAX_IMAGE_FEE + 1, true);

    expect(result.ok).toBe(true);
  });

  // Raise-only: a fee already stored above the ceiling stays savable, or a creator whose stored fee
  // predates the ceiling could never touch anything else on the version.
  it('lets a stored over-ceiling fee be re-saved unchanged', async () => {
    state.rows = [version({ baseModel: 'SDXL 1.0', currentFee: MAX_IMAGE_FEE + 50 })];

    const result = await setLicensingFee(7, GOLD, 1, MAX_IMAGE_FEE + 50, true);

    expect(result.ok).toBe(true);
  });

  it('still refuses raising an already over-ceiling fee', async () => {
    state.rows = [version({ baseModel: 'SDXL 1.0', currentFee: MAX_IMAGE_FEE + 50 })];

    const result = await setLicensingFee(7, GOLD, 1, MAX_IMAGE_FEE + 51, true);

    expect(result.ok).toBe(false);
    expect(state.written).toEqual([]);
  });
});

describe('returning the slot when a fee is cleared', () => {
  it('releases a version nobody ever bought or generated with', async () => {
    state.rows = [version({ currentFee: 5 })];

    const result = await setLicensingFee(7, GOLD, 1, null, true);

    expect(result.ok).toBe(true);
    expect(state.released).toEqual([[1]]);
  });

  it('releases nothing when the fee is being SET rather than cleared', async () => {
    state.rows = [version({ currentFee: null })];

    await setLicensingFee(7, GOLD, 1, 1, true);

    expect(state.released).toEqual([]);
  });

  // The version is still priced by the gate, so there is nothing to give back.
  it('keeps the slot when a permanent gate still stands', async () => {
    state.rows = [version({ currentFee: 5, gated: 1 })];

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([]);
  });

  it('keeps the slot when someone else holds access', async () => {
    state.rows = [version({ currentFee: 5, sold: true })];

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([]);
  });

  // earned is an ALL-TIME total, so it cannot say whether anything was charged while this slot was
  // live — it only decides when ClickHouse is down.
  it('does not keep the slot on a lifetime total alone', async () => {
    state.rows = [version({ currentFee: 5, publishedAt: new Date('2026-01-01'), earned: 3 })];

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([[1]]);
  });

  // An unpublished version is judged without either fee source — the case a creator actually hits, and
  // the one with no staleness in it.
  it('releases an unpublished version even if the earnings mirror reads nonzero', async () => {
    state.rows = [version({ currentFee: 5, earned: 3 })];

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([[1]]);
  });

  // The compensation table is current to one orchestrator flush, where the earnings mirror is a day
  // behind — this is the whole reason a same-day price-and-clear can be answered at all.
  it('keeps the slot when a fee was charged since it was spent', async () => {
    state.rows = [version({ currentFee: 5, publishedAt: new Date('2026-01-01') })];
    state.charges = { 1: '2026-08-24' };

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([]);
  });

  // The regression Justin's review caught: max(date) is a DAY, so a charge made at any time on the
  // 24th reads as the 24th at midnight — before a slot created that afternoon. Comparing raw dates
  // refunded a version that had just been paid for, which is the exact case this lookup exists for.
  it('keeps the slot when the charge lands the same DAY the slot was spent', async () => {
    state.rows = [
      version({
        currentFee: 5,
        publishedAt: new Date('2026-01-01'),
        slotCreatedAt: new Date('2026-08-24T14:00:00.000Z'),
      }),
    ];
    state.charges = { 1: '2026-08-24' };

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([]);
  });

  // Scoped to the slot: a version that earned before its owner priced it does not hold the slot it
  // never paid for.
  it('releases when the only charges predate the slot', async () => {
    state.rows = [version({ currentFee: 5, publishedAt: new Date('2026-01-01'), earned: 999 })];
    state.charges = { 1: '2026-01-05' };

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([[1]]);
  });

  // Fails soft, not open: with ClickHouse unavailable the day-behind mirror decides.
  it('falls back to the earnings mirror when ClickHouse is down', async () => {
    state.rows = [version({ currentFee: 5, publishedAt: new Date('2026-01-01'), earned: 3 })];
    state.clickhouseDown = true;

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.released).toEqual([]);
  });

  // An unpublished version cannot have been charged for, so it is answered without ClickHouse at all.
  it('asks ClickHouse nothing about an unpublished version', async () => {
    state.rows = [version({ currentFee: 5 })];

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.chargeQueries).toEqual([]);
    expect(state.released).toEqual([[1]]);
  });

  // userId is not a safe bound: it defaults to 0 for an unknown owner and keeps whoever was stamped at
  // charge time, so a transferred model would silently report no charges and refund a spent slot.
  it('bounds the charge query on date and version, never on owner', async () => {
    state.rows = [version({ currentFee: 5, publishedAt: new Date('2026-01-01') })];

    await setLicensingFee(7, GOLD, 1, null, true);

    expect(state.chargeQueries).toHaveLength(1);
    expect(state.chargeQueries[0]).toContain("date >= toDate('2026-08-20')");
    expect(state.chargeQueries[0]).not.toContain('userId');
  });

  it('releases only the untransacted half of a bulk clear', async () => {
    state.rows = [version({ id: 1, currentFee: 5 }), version({ id: 2, currentFee: 5, sold: true })];

    await bulkSetLicensingFee(7, GOLD, [1, 2], null, true);

    expect(state.released).toEqual([[1]]);
  });
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
