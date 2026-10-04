import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks';

// Prod's shape: civitai.red is configured as both the blue and the red domain.
vi.stubEnv('SERVER_DOMAIN_GREEN', 'civitai.com');
vi.stubEnv('SERVER_DOMAIN_BLUE', 'civitai.red');
vi.stubEnv('SERVER_DOMAIN_RED', 'civitai.red');
vi.resetModules();

const createBuzzTransactionMany = vi.fn();
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany,
}));

const {
  autoPayPrizes,
  claimPrize,
  createPrizes,
  getPrizeBuzzChoices,
  getRequestPrizeBuzzChoices,
  payPrize,
  voidPrizes,
} = await import('~/server/services/prize.service');

type Row = {
  id: number;
  userId: number;
  sourceType: 'Crucible' | 'Challenge';
  sourceId: number;
  subjectId: number | null;
  position: number | null;
  amount: number;
  title: string;
  externalTransactionId: string;
  createdAt: Date;
  autoClaimAt: Date;
  claimedAt: Date | null;
  buzzType: string | null;
  autoClaimed: boolean;
  paidAt: Date | null;
  voidedAt: Date | null;
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-04T12:00:00Z');

/** An in-memory Prize table honouring the conditions the service writes under. */
let rows: Row[] = [];
type Where = Record<string, unknown>;
const matches = (row: Row, where: Where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (cond === undefined) return true;
    if (cond === null) return value === null;
    if (cond instanceof Date || typeof cond !== 'object') return value === cond;
    const c = cond as { in?: unknown[]; not?: null; lte?: Date; gt?: number };
    if (c.in && !c.in.includes(value)) return false;
    if ('not' in c && c.not === null && value === null) return false;
    if (c.lte && !(value instanceof Date && value <= c.lte)) return false;
    if (c.gt !== undefined && !((value as number) > c.gt)) return false;
    return true;
  });

const prize = dbMock.dbWrite.prize;
const installFakeTable = () => {
  prize.createMany.mockImplementation(async ({ data }: { data: Omit<Row, 'id'>[] }) => {
    let count = 0;
    for (const input of data) {
      if (rows.some((r) => r.externalTransactionId === input.externalTransactionId)) continue;
      rows.push({
        subjectId: null,
        position: null,
        claimedAt: null,
        buzzType: null,
        autoClaimed: false,
        paidAt: null,
        voidedAt: null,
        ...input,
        id: rows.length + 1,
      });
      count++;
    }
    return { count };
  });
  prize.findMany.mockImplementation(async ({ where, take }: { where: Where; take?: number }) =>
    rows
      .filter((r) => matches(r, where))
      .slice(0, take ?? Infinity)
      .map((r) => ({ ...r }))
  );
  prize.findFirst.mockImplementation(async ({ where }: { where: Where }) => {
    const row = rows.find((r) => matches(r, where));
    return row ? { ...row } : null;
  });
  prize.findUniqueOrThrow.mockImplementation(async ({ where }: { where: Where }) => {
    const row = rows.find((r) => matches(r, where));
    if (!row) throw new Error('not found');
    return { ...row };
  });
  prize.updateMany.mockImplementation(
    async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }
  );
};

const award = (overrides: Partial<Row> = {}) =>
  createPrizes(
    [
      {
        userId: 10,
        sourceType: 'Crucible',
        sourceId: 1,
        subjectId: 5,
        position: 1,
        amount: 900,
        title: 'Crucible prize - 1st place',
        externalTransactionId: `crucible-prize-1-5-1-${rows.length}`,
        ...overrides,
      },
    ],
    { now: overrides.createdAt ?? NOW }
  );

const ledgerCalls = () =>
  createBuzzTransactionMany.mock.calls.map(
    ([txs]) => txs as { toAccountType: string; externalTransactionId: string; amount: number }[]
  );

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  installFakeTable();
  createBuzzTransactionMany.mockImplementation(async (txs: unknown[]) => ({
    transactions: txs,
    conflicts: [],
  }));
});

describe('which Buzz a winner may choose', () => {
  it('offers only green on the green site', () => {
    expect(getPrizeBuzzChoices('green')).toEqual(['green']);
    expect(getRequestPrizeBuzzChoices({ headers: { host: 'civitai.com' } })).toEqual(['green']);
  });

  it('offers green or yellow on civitai.red', () => {
    expect(getRequestPrizeBuzzChoices({ headers: { host: 'civitai.red' } })).toEqual([
      'green',
      'yellow',
    ]);
  });

  // createContext defaults an unresolved host to blue; reading that default would offer yellow.
  it('offers only green on a host it cannot resolve', () => {
    expect(getRequestPrizeBuzzChoices({ headers: { host: 'evil.example' } })).toEqual(['green']);
    expect(getRequestPrizeBuzzChoices({ headers: {} })).toEqual(['green']);
  });
});

describe('claiming on civitai.com', () => {
  it('pays green, whatever the request asks for', async () => {
    const [{ id }] = await award();

    const result = await claimPrize({ id, userId: 10, buzzType: 'yellow', choices: ['green'] });

    expect(ledgerCalls()).toEqual([
      [expect.objectContaining({ toAccountType: 'green', amount: 900, fromAccountId: 0 })],
    ]);
    expect(result).toMatchObject({ buzzType: 'green', paid: true, choices: ['green'] });
  });
});

describe('claiming on civitai.red', () => {
  it.each(['green', 'yellow'] as const)('pays the %s the winner chose', async (buzzType) => {
    const [{ id }] = await award();

    await claimPrize({ id, userId: 10, buzzType, choices: ['green', 'yellow'] });

    expect(ledgerCalls()).toEqual([[expect.objectContaining({ toAccountType: buzzType })]]);
  });

  it('refuses a claim that does not choose, and pays nothing', async () => {
    const [{ id }] = await award();

    await expect(claimPrize({ id, userId: 10, choices: ['green', 'yellow'] })).rejects.toThrow(
      'Choose which Buzz'
    );

    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(rows[0].claimedAt).toBeNull();
  });
});

describe('claiming twice', () => {
  it('pays once when the winner claims again', async () => {
    const [{ id }] = await award();

    await claimPrize({ id, userId: 10, buzzType: 'yellow', choices: ['green', 'yellow'] });
    const second = await claimPrize({
      id,
      userId: 10,
      buzzType: 'green',
      choices: ['green', 'yellow'],
    });

    expect(createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ buzzType: 'yellow', paid: true });
  });

  it('pays once when two claims race', async () => {
    const [{ id }] = await award();

    await Promise.all([
      claimPrize({ id, userId: 10, buzzType: 'yellow', choices: ['green', 'yellow'] }),
      claimPrize({ id, userId: 10, buzzType: 'green', choices: ['green', 'yellow'] }),
    ]);

    expect(createBuzzTransactionMany).toHaveBeenCalledTimes(1);
  });

  it('pays with the ledger key the source awarded, so the ledger refuses a second payment', async () => {
    const [{ id }] = await award({ externalTransactionId: 'crucible-prize-1-5-1' });

    await claimPrize({ id, userId: 10, choices: ['green'] });

    expect(ledgerCalls()[0][0].externalTransactionId).toBe('crucible-prize-1-5-1');
  });

  it('counts a payment the ledger already holds as paid, and moves nothing new', async () => {
    createBuzzTransactionMany.mockImplementation(async (txs: unknown[]) => ({
      transactions: [],
      conflicts: txs,
    }));
    const [{ id }] = await award();

    const result = await claimPrize({ id, userId: 10, choices: ['green'] });

    expect(result.paid).toBe(true);
  });

  it('leaves a claim the ledger dropped unpaid, for the job to retry', async () => {
    createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
    const [{ id }] = await award();

    const result = await claimPrize({ id, userId: 10, choices: ['green'] });

    expect(result).toMatchObject({ buzzType: 'green', paid: false });
  });
});

describe('who can claim', () => {
  it("refuses someone else's prize", async () => {
    const [{ id }] = await award();

    await expect(claimPrize({ id, userId: 99, choices: ['green'] })).rejects.toThrow(
      'Prize not found'
    );
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('refuses a voided prize', async () => {
    const [{ id }] = await award();
    await voidPrizes('Crucible', 1);

    await expect(claimPrize({ id, userId: 10, choices: ['green'] })).rejects.toThrow(
      'no longer available'
    );
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

describe('awarding', () => {
  it('records a re-run once, by its ledger key', async () => {
    await award({ externalTransactionId: 'k' });
    await award({ externalTransactionId: 'k' });

    expect(rows).toHaveLength(1);
  });

  it('sets the prize to pay itself 30 days after it was won', async () => {
    const [row] = await award();

    expect(row.autoClaimAt.getTime() - NOW.getTime()).toBe(30 * DAY);
  });
});

describe('the auto-pay job', () => {
  it('pays an unclaimed prize green once it is due', async () => {
    await award({ createdAt: new Date(NOW.getTime() - 31 * DAY) });

    const result = await autoPayPrizes({ now: NOW });

    expect(result.autoClaimed).toBe(1);
    expect(ledgerCalls()).toEqual([[expect.objectContaining({ toAccountType: 'green' })]]);
    expect(rows[0]).toMatchObject({ buzzType: 'green', autoClaimed: true });
    expect(rows[0].paidAt).not.toBeNull();
  });

  it('leaves a prize alone until it is due', async () => {
    await award({ createdAt: new Date(NOW.getTime() - 29 * DAY) });

    await autoPayPrizes({ now: NOW });

    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(rows[0].claimedAt).toBeNull();
  });

  it('does not touch a prize the winner already claimed and was paid for', async () => {
    const [{ id }] = await award({ createdAt: new Date(NOW.getTime() - 31 * DAY) });
    await claimPrize({ id, userId: 10, buzzType: 'yellow', choices: ['green', 'yellow'] });

    await autoPayPrizes({ now: NOW });

    expect(createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ buzzType: 'yellow', autoClaimed: false });
  });

  it('retries a claim whose payment did not land, in the currency the winner chose', async () => {
    createBuzzTransactionMany.mockResolvedValueOnce({ transactions: [], conflicts: [] });
    const [{ id }] = await award();
    await claimPrize({ id, userId: 10, buzzType: 'yellow', choices: ['green', 'yellow'] });
    rows[0].claimedAt = new Date(NOW.getTime() - 11 * 60 * 1000);

    const result = await autoPayPrizes({ now: NOW });

    expect(result.retried).toBe(1);
    expect(ledgerCalls().at(-1)).toEqual([expect.objectContaining({ toAccountType: 'yellow' })]);
    expect(rows[0].paidAt).not.toBeNull();
  });

  it('never pays a voided prize', async () => {
    await award({ createdAt: new Date(NOW.getTime() - 31 * DAY) });
    await voidPrizes('Crucible', 1);

    await autoPayPrizes({ now: NOW });

    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

describe('paying', () => {
  // A prize voided between its claim and its payment reaches payPrize with the claim already set.
  it('refuses a prize voided after it was claimed', async () => {
    const [row] = await award();

    const paid = await payPrize({
      ...row,
      claimedAt: NOW,
      buzzType: 'green',
      voidedAt: NOW,
    });

    expect(paid).toBe(false);
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});
