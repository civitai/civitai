import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { REDIS_KEYS } from '~/server/redis/client';

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
  getMyPrizes,
  getPrize,
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

/**
 * An in-memory Prize table honouring the conditions the service writes under. It refuses what the
 * real table refuses (a duplicate ledger key without skipDuplicates, a non-positive amount) and
 * throws on any filter it does not implement, so it can never match more rows than Postgres would.
 */
let rows: Row[] = [];
type Where = Record<string, unknown>;
const OPERATORS = new Set(['in', 'not', 'lte', 'gt']);
const matches = (row: Row, where: Where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (cond === undefined) return true;
    if (cond === null) return value === null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond !== 'object') return value === cond;
    const unknown = Object.keys(cond).filter((op) => !OPERATORS.has(op));
    if (unknown.length) throw new Error(`fake Prize table: unsupported filter ${unknown.join()}`);
    const c = cond as { in?: unknown[]; not?: null; lte?: Date; gt?: number };
    if ('not' in c && c.not !== null) throw new Error('fake Prize table: only { not: null }');
    if (c.in && !c.in.includes(value)) return false;
    if ('not' in c && value === null) return false;
    if (c.lte && !(value instanceof Date && value <= c.lte)) return false;
    if (c.gt !== undefined && !((value as number) > c.gt)) return false;
    return true;
  });
const ordered = (list: Row[], orderBy?: Record<string, 'asc' | 'desc'>) => {
  if (!orderBy) return list;
  const [[key, dir]] = Object.entries(orderBy) as [keyof Row, 'asc' | 'desc'][];
  const sign = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => sign * (Number(a[key]) - Number(b[key])));
};

/** Users by id; only the fields the service filters on. */
let users = new Map<number, { bannedAt: Date | null; muted: boolean }>();
const prize = dbMock.dbWrite.prize;
const installFakeTable = () => {
  dbMock.dbWrite.user.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: number[] }; bannedAt: { not: null } } }) => {
      if (Object.keys(where).sort().join() !== 'bannedAt,id' || where.bannedAt.not !== null)
        throw new Error('fake User table: unsupported filter');
      return where.id.in.filter((id) => users.get(id)?.bannedAt).map((id) => ({ id }));
    }
  );
  prize.createMany.mockImplementation(
    async ({ data, skipDuplicates }: { data: Omit<Row, 'id'>[]; skipDuplicates?: boolean }) => {
      if (data.some((input) => !(input.amount > 0)))
        throw new Error('violates check constraint "Prize_amount_check"');
      let count = 0;
      for (const input of data) {
        if (rows.some((r) => r.externalTransactionId === input.externalTransactionId)) {
          if (skipDuplicates) continue;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
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
    }
  );
  prize.findMany.mockImplementation(
    async ({
      where,
      take,
      orderBy,
    }: {
      where: Where;
      take?: number;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }) =>
      ordered(
        rows.filter((r) => matches(r, where)),
        orderBy
      )
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
  users = new Map();
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

  // Blue is not a promise of red: an SFW blue front door must not be offered yellow.
  it('offers only green on a blue host that is not red-capable', () => {
    expect(getPrizeBuzzChoices('blue')).toEqual(['green']);
    expect(getPrizeBuzzChoices('red')).toEqual(['green', 'yellow']);
  });

  // Not createContext's blue default: an unresolved host resolves to nothing, and nothing is green.
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

  // An unfunded user challenge still picks winners, at 0 Buzz; the table refuses a 0-amount row.
  it('skips a zero prize instead of failing the whole award', async () => {
    const awarded = await createPrizes(
      [0, 900].map((amount) => ({
        userId: 10 + amount,
        sourceType: 'Challenge' as const,
        sourceId: 3,
        amount,
        title: 'Challenge Winner Prize',
        externalTransactionId: `challenge-winner-prize-3-${amount}`,
      })),
      { now: NOW }
    );

    expect(awarded.map((p) => p.amount)).toEqual([900]);
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

describe('the auto-pay job, at volume', () => {
  const seed = (count: number, overrides: Partial<Row>) => {
    for (let i = 0; i < count; i++)
      rows.push({
        id: rows.length + 1,
        userId: 10,
        sourceType: 'Crucible',
        sourceId: 1,
        subjectId: i,
        position: 1,
        amount: 100,
        title: 'Crucible 1st prize',
        externalTransactionId: `crucible-prize-1-${i}-1`,
        createdAt: new Date(NOW.getTime() - 31 * DAY),
        autoClaimAt: new Date(NOW.getTime() - DAY),
        claimedAt: null,
        buzzType: null,
        autoClaimed: false,
        paidAt: null,
        voidedAt: null,
        ...overrides,
      });
  };

  it('claims every due prize across batches, not just the first 200', async () => {
    seed(201, {});

    const result = await autoPayPrizes({ now: NOW });

    expect(result.autoClaimed).toBe(201);
    expect(rows.every((r) => r.paidAt)).toBe(true);
  });

  // The retry loop walks a cursor: without it, 200 payments that keep failing are retried 20 times.
  it('tries each stuck payment once per run, however many there are', async () => {
    createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
    seed(201, { claimedAt: new Date(NOW.getTime() - DAY), buzzType: 'green' });

    const result = await autoPayPrizes({ now: NOW });

    expect(createBuzzTransactionMany).toHaveBeenCalledTimes(201);
    expect(result.retried).toBe(0);
  });

  it('leaves a claim made minutes ago to its own payment', async () => {
    createBuzzTransactionMany.mockResolvedValueOnce({ transactions: [], conflicts: [] });
    const [{ id }] = await award();
    await claimPrize({ id, userId: 10, choices: ['green'] });
    rows[0].claimedAt = new Date(NOW.getTime() - 60 * 1000);

    const result = await autoPayPrizes({ now: NOW });

    expect(result.retried).toBe(0);
    expect(createBuzzTransactionMany).toHaveBeenCalledTimes(1);
  });
});

describe('voiding', () => {
  // A claimed prize's payment may already be in flight or in the ledger: voiding it would leave a
  // row that says "voided" over Buzz the winner received, and the job would never revisit it.
  it('leaves a claimed prize owed, and the job finishes paying it', async () => {
    createBuzzTransactionMany.mockResolvedValueOnce({ transactions: [], conflicts: [] });
    const [{ id }] = await award();
    await claimPrize({ id, userId: 10, buzzType: 'yellow', choices: ['green', 'yellow'] });

    const voided = await voidPrizes('Crucible', 1);
    rows[0].claimedAt = new Date(NOW.getTime() - 11 * 60 * 1000);
    await autoPayPrizes({ now: NOW });

    expect(voided).toBe(0);
    expect(rows[0].voidedAt).toBeNull();
    expect(rows[0].paidAt).not.toBeNull();
  });

  it('voids an unclaimed prize', async () => {
    await award();

    expect(await voidPrizes('Crucible', 1)).toBe(1);
    expect(rows[0].voidedAt).not.toBeNull();
  });
});

describe('a banned winner', () => {
  const ban = (userId: number) => users.set(userId, { bannedAt: NOW, muted: false });
  const unban = (userId: number) => users.set(userId, { bannedAt: null, muted: false });

  it('cannot claim while banned, and nothing is paid or recorded', async () => {
    ban(10);
    const [{ id }] = await award();

    await expect(
      claimPrize({ id, userId: 10, buzzType: 'yellow', choices: ['green', 'yellow'] })
    ).rejects.toThrow('on hold while your account is banned');

    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ claimedAt: null, voidedAt: null });
  });

  it('has a due prize held by the job, not auto-paid and not voided', async () => {
    ban(10);
    await award({ createdAt: new Date(NOW.getTime() - 31 * DAY) });

    const result = await autoPayPrizes({ now: NOW });

    expect(result.autoClaimed).toBe(0);
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ claimedAt: null, voidedAt: null });
  });

  it('has a claimed but unpaid prize held by the job too', async () => {
    createBuzzTransactionMany.mockResolvedValueOnce({ transactions: [], conflicts: [] });
    const [{ id }] = await award();
    await claimPrize({ id, userId: 10, choices: ['green'] });
    rows[0].claimedAt = new Date(NOW.getTime() - 11 * 60 * 1000);
    ban(10);

    const result = await autoPayPrizes({ now: NOW });

    expect(result.retried).toBe(0);
    expect(createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(rows[0].paidAt).toBeNull();
  });

  it('is paid once the ban is lifted', async () => {
    ban(10);
    await award({ createdAt: new Date(NOW.getTime() - 31 * DAY) });
    await autoPayPrizes({ now: NOW });
    unban(10);

    const result = await autoPayPrizes({ now: NOW });

    expect(result.autoClaimed).toBe(1);
    expect(ledgerCalls()).toEqual([[expect.objectContaining({ toAccountType: 'green' })]]);
  });

  it('does not hold back the next winner in the same batch', async () => {
    ban(10);
    await award({ createdAt: new Date(NOW.getTime() - 31 * DAY) });
    await award({ createdAt: new Date(NOW.getTime() - 31 * DAY), userId: 11 });

    const result = await autoPayPrizes({ now: NOW });

    expect(result.autoClaimed).toBe(1);
    expect(ledgerCalls()).toEqual([[expect.objectContaining({ toAccountId: 11 })]]);
  });
});

describe('a batch full of held prizes', () => {
  // Held prizes stay due. Re-reading them from the top every batch would starve whoever is behind.
  it('does not stop the job reaching the winners queued behind them', async () => {
    users.set(10, { bannedAt: NOW, muted: false });
    for (let i = 0; i < 200; i++)
      await award({
        createdAt: new Date(NOW.getTime() - 31 * DAY),
        externalTransactionId: `held-${i}`,
      });
    await award({
      createdAt: new Date(NOW.getTime() - 31 * DAY),
      userId: 11,
      externalTransactionId: 'next',
    });

    const result = await autoPayPrizes({ now: NOW });

    expect(result.autoClaimed).toBe(1);
    expect(ledgerCalls()).toEqual([[expect.objectContaining({ toAccountId: 11 })]]);
  });
});

describe('a muted winner', () => {
  it('claims and is paid as usual', async () => {
    users.set(10, { bannedAt: null, muted: true });
    const [{ id }] = await award();

    const result = await claimPrize({
      id,
      userId: 10,
      buzzType: 'yellow',
      choices: ['green', 'yellow'],
    });

    expect(result).toMatchObject({ buzzType: 'yellow', paid: true });
  });
});

describe('reading prizes', () => {
  it("never returns someone else's prize", async () => {
    const [{ id }] = await award();

    await expect(getPrize({ id, userId: 99, choices: ['green'] })).rejects.toThrow(
      'Prize not found'
    );
    expect(await getMyPrizes({ userId: 99, choices: ['green'] })).toEqual([]);
  });

  it('lists only your own, unvoided prizes', async () => {
    await award({ externalTransactionId: 'mine' });
    await award({ externalTransactionId: 'theirs', userId: 99 });
    await award({ externalTransactionId: 'voided', sourceId: 2 });
    await voidPrizes('Crucible', 2);

    const mine = await getMyPrizes({ userId: 10, choices: ['green'] });

    expect(mine.map((p) => p.id)).toEqual([1]);
  });
});

describe('paying', () => {
  it("refreshes a crucible winner's Buzz-won total once paid", async () => {
    const [{ id }] = await award();

    await claimPrize({ id, userId: 10, choices: ['green'] });

    expect(redisMock.redis.del).toHaveBeenCalledWith(`${REDIS_KEYS.CRUCIBLE.USER_BUZZ_WON}:10`);
  });

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
