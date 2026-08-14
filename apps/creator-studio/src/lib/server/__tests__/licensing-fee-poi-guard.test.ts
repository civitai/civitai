import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '../membership';

// Kysely fake. `rows` is what the owned-versions read returns; `written` records every `.set()` so a test
// can assert the write never happened — a guard that returns 400 after writing would otherwise pass.
const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  written: [] as Record<string, unknown>[],
}));

vi.mock('$lib/server/db', () => {
  const select: Record<string, unknown> = {};
  const update: Record<string, unknown> = {};
  const chain = (target: Record<string, unknown>) =>
    new Proxy(target, {
      get: (t, prop: string) => t[prop] ?? (() => chain(t)),
    });
  select.execute = async () => state.rows;
  update.set = (values: Record<string, unknown>) => {
    state.written.push(values);
    return chain(update);
  };
  update.executeTakeFirst = async () => ({ numUpdatedRows: BigInt(state.rows.length) });
  update.execute = async () => [];
  const db = {
    selectFrom: () => chain(select),
    updateTable: () => chain(update),
    transaction: () => ({ execute: async (cb: (trx: unknown) => unknown) => cb(db) }),
  };
  return { dbRead: db, dbWrite: db };
});

const { setLicensingFee, bulkSetLicensingFee } = await import('../monetization/licensing-fee');

const GOLD: Membership = { tier: 'gold', isMember: true, isCreatorProgramMember: true };

const version = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  baseModel: 'SDXL 1.0',
  modelType: 'Checkpoint',
  currentFee: null,
  meta: null,
  poi: false,
  ...over,
});

beforeEach(() => {
  state.rows = [];
  state.written = [];
});

// Creator Studio writes `licensingFee` with its own SQL and never reaches the main app, so the POI rule
// #3903 enforces there has to be re-applied here or this spoke is a way around it. The non-POI cases are
// the positive control: they prove the refusal comes from `poi`, not from a fixture that can't save at all.
describe('licensing fee POI guard', () => {
  it('refuses a fee on a version whose model depicts a real person', async () => {
    state.rows = [version({ poi: true })];

    const result = await setLicensingFee(7, GOLD, 1, 1, true);

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "A model depicting a real person can't be monetized.",
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
