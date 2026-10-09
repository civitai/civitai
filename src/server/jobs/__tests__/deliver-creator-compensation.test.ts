import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { creatorCompAmountPaidCounter, generationTipAmountPaidCounter } from '~/server/prom/client';
import {
  GENERATION_TIP_TRANSACTION_PREFIX,
  TransactionType,
} from '~/shared/constants/buzz.constants';

const { mockClickhouseQuery, mockCreateBuzzTransactionMany } = vi.hoisted(() => ({
  mockClickhouseQuery: vi.fn(),
  mockCreateBuzzTransactionMany: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: mockClickhouseQuery },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
}));
vi.mock('~/server/jobs/job', () => ({
  // Keeps the handler so the tests drive the job as the scheduler does.
  createJob: vi.fn((name: string, cron: string, run: () => Promise<void>) => ({ name, cron, run })),
  getJobDate: vi.fn(),
}));

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { getJobDate } from '~/server/jobs/job';
import {
  buildPayoutTransactions,
  GENERATION_TIP_TRANSACTION_START,
  MAX_PAYOUT_DATES_PER_RUN,
  runPayout,
  updateCreatorResourceCompensation,
  type PayoutTransaction,
} from '~/server/jobs/deliver-creator-compensation';

type Row = Parameters<typeof buildPayoutTransactions>[1][number][number];

const CREATOR = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = GENERATION_TIP_TRANSACTION_START;
const DAY_BEFORE_START = new Date(START.getTime() - DAY_MS);
const DAY_AFTER_START = new Date(START.getTime() + DAY_MS);

const row = (source: string, accountType: string, amount: number, modelVersionId = 1): Row =>
  ({ modelVersionId, source, accountType, amount } as Row);

// Fractional on purpose: flooring tips and compensation separately would lose a Buzz here.
const ROWS: Row[] = [
  row('compensation', 'Yellow', 100.6),
  row('tip', 'Yellow', 20.7),
  row('compensation', 'Blue', 3.2),
  row('tip', 'Blue', 4.9),
  row('tip', 'Green', 12),
  row('licenseFee', 'Yellow', 9.5),
];

const view = (txs: PayoutTransaction[]) =>
  txs
    .map(({ externalTransactionId, amount, description, type }) => ({
      externalTransactionId,
      amount,
      description,
      type,
    }))
    .sort((a, b) => a.externalTransactionId.localeCompare(b.externalTransactionId));

/** The buzz service dedups on externalTransactionId alone: a known key is a conflict, whatever its amount. */
function applyToLedger(ledger: Map<string, PayoutTransaction>, txs: PayoutTransaction[]) {
  for (const tx of txs)
    if (!ledger.has(tx.externalTransactionId)) ledger.set(tx.externalTransactionId, tx);
  const held: Record<string, number> = {};
  for (const tx of ledger.values())
    if (tx.source !== 'licenseFee')
      held[tx.toAccountType] = (held[tx.toAccountType] ?? 0) + tx.amount;
  return held;
}

describe('buildPayoutTransactions: generation tips', () => {
  it('pays tips in their own Compensation transaction, keyed generation-tip-', () => {
    expect(view(buildPayoutTransactions(START, { [CREATOR]: ROWS }))).toEqual([
      {
        externalTransactionId: 'creator-tip-comp-2026-10-13-7-Blue',
        amount: 4, // floor(3.2 + 4.9) - floor(4.9)
        description: 'Generation compensation (Oct 13, 2026)',
        type: TransactionType.Compensation,
      },
      {
        externalTransactionId: 'creator-tip-comp-2026-10-13-7-Yellow',
        amount: 101, // floor(100.6 + 20.7) - floor(20.7)
        description: 'Generation compensation (Oct 13, 2026)',
        type: TransactionType.Compensation,
      },
      {
        externalTransactionId: 'generation-tip-2026-10-13-7-Blue',
        amount: 4,
        description: 'Generation tips (Oct 13, 2026)',
        type: TransactionType.Compensation,
      },
      {
        externalTransactionId: 'generation-tip-2026-10-13-7-Green',
        amount: 12,
        description: 'Generation tips (Oct 13, 2026)',
        type: TransactionType.Compensation,
      },
      {
        externalTransactionId: 'generation-tip-2026-10-13-7-Yellow',
        amount: 20,
        description: 'Generation tips (Oct 13, 2026)',
        type: TransactionType.Compensation,
      },
      {
        externalTransactionId: 'license-fee-2026-10-13-7-Yellow',
        amount: 9,
        description: 'License fee payout (Oct 13, 2026)',
        type: TransactionType.LicenseFee,
      },
    ]);
  });

  // The comp transaction keeps the key the combined transaction had. Renaming it would make a retry
  // of a day paid before the split mint the compensation a second time.
  it('keeps the creator-tip-comp- key for compensation', () => {
    const comp = buildPayoutTransactions(START, { [CREATOR]: ROWS }).filter(
      (tx) => tx.source === 'compensation'
    );
    expect(comp.map((tx) => tx.externalTransactionId).sort()).toEqual([
      'creator-tip-comp-2026-10-13-7-Blue',
      'creator-tip-comp-2026-10-13-7-Yellow',
    ]);
  });

  it('pays a tips-only creator a tip transaction and no empty compensation', () => {
    expect(
      view(buildPayoutTransactions(START, { [CREATOR]: [row('tip', 'Yellow', 30.9)] }))
    ).toEqual([
      {
        externalTransactionId: 'generation-tip-2026-10-13-7-Yellow',
        amount: 30,
        description: 'Generation tips (Oct 13, 2026)',
        type: TransactionType.Compensation,
      },
    ]);
  });

  it('converts cash license fees from tenths of a penny', () => {
    const [tx] = buildPayoutTransactions(START, {
      [CREATOR]: [row('licenseFee', 'CashSettled', 105)],
    });
    expect(tx).toMatchObject({
      externalTransactionId: 'license-fee-2026-10-13-7-CashSettled',
      amount: 10,
    });
  });

  // Only sees the flooring: any split that keeps each account's total passes.
  it.each([
    ['the day before the split', DAY_BEFORE_START],
    ['the first split day', START],
    ['the day after', DAY_AFTER_START],
  ])('floors comp plus tips once per account on %s', (_, date) => {
    const held = applyToLedger(new Map(), buildPayoutTransactions(date, { [CREATOR]: ROWS }));
    expect(held).toEqual({ Yellow: 121, Blue: 8, Green: 12 });
  });

  // DECISION: payout dates before GENERATION_TIP_TRANSACTION_START are built exactly as the combined
  // transaction was. If you are about to drop the date gate because "the split is always right": a
  // failed run is retried for the same date, possibly on new code, and the admin payout endpoint can
  // replay any date. A day the combined transaction already paid would then get a new
  // generation-tip- key, which the buzz service does not dedup, and every tip that day would be paid
  // twice.
  it('retrying a day already paid as one combined transaction pays nothing more', () => {
    // What the code before the split paid for that day, written out rather than built.
    const paidBeforeTheSplit: PayoutTransaction[] = [
      ['Yellow', 121],
      ['Blue', 8],
      ['Green', 12],
    ].map(([acct, amount]) => ({
      fromAccountId: 0,
      toAccountId: CREATOR,
      fromAccountType: acct as PayoutTransaction['toAccountType'],
      toAccountType: acct as PayoutTransaction['toAccountType'],
      amount: amount as number,
      description: 'Generation compensation (Oct 12, 2026)',
      type: TransactionType.Compensation,
      externalTransactionId: `creator-tip-comp-2026-10-12-${CREATOR}-${acct}`,
      source: 'compensation' as const,
    }));
    const ledger = new Map(paidBeforeTheSplit.map((tx) => [tx.externalTransactionId, tx]));

    const held = applyToLedger(
      ledger,
      buildPayoutTransactions(DAY_BEFORE_START, { [CREATOR]: ROWS })
    );

    expect([...ledger.keys()].filter((key) => !key.startsWith('license-fee-'))).toEqual(
      paidBeforeTheSplit.map((tx) => tx.externalTransactionId)
    );
    expect(held).toEqual({ Yellow: 121, Blue: 8, Green: 12 });
  });
});

describe('runPayout', () => {
  beforeEach(() => {
    mockClickhouseQuery.mockReset();
    mockCreateBuzzTransactionMany.mockReset();
    mockCreateBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
    dbMock.dbRead.$queryRaw.mockReset();
    vi.mocked(generationTipAmountPaidCounter.inc).mockClear();
    vi.mocked(creatorCompAmountPaidCounter.inc).mockClear();
  });

  const sentTransactions = () =>
    mockCreateBuzzTransactionMany.mock.calls.flatMap(([batch]) => batch);

  it('pays the day the job last ran for, split, without the local source key', async () => {
    mockClickhouseQuery.mockResolvedValue([
      row('compensation', 'Yellow', 50, 11),
      row('tip', 'Yellow', 6, 11),
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ userId: CREATOR, modelVersionIds: [11] }]);

    // The job stamps its last run with the time it finished, not midnight.
    await runPayout(new Date(START.getTime() + 13 * 60 * 60 * 1000));

    expect(mockClickhouseQuery.mock.calls[0].slice(1)).toEqual([START]);
    const sent = sentTransactions();
    expect(sent).toEqual(
      expect.arrayContaining([
        {
          fromAccountId: 0,
          toAccountId: CREATOR,
          fromAccountType: 'Yellow',
          toAccountType: 'Yellow',
          amount: 6,
          description: 'Generation tips (Oct 13, 2026)',
          type: TransactionType.Compensation,
          externalTransactionId: 'generation-tip-2026-10-13-7-Yellow',
        },
        {
          fromAccountId: 0,
          toAccountId: CREATOR,
          fromAccountType: 'Yellow',
          toAccountType: 'Yellow',
          amount: 50,
          description: 'Generation compensation (Oct 13, 2026)',
          type: TransactionType.Compensation,
          externalTransactionId: 'creator-tip-comp-2026-10-13-7-Yellow',
        },
      ])
    );
    expect(sent).toHaveLength(2);
    expect(generationTipAmountPaidCounter.inc).toHaveBeenCalledWith({ account_type: 'Yellow' }, 6);
    expect(creatorCompAmountPaidCounter.inc).toHaveBeenCalledWith({ account_type: 'Yellow' }, 50);
    expect(generationTipAmountPaidCounter.inc).toHaveBeenCalledTimes(1);
    expect(creatorCompAmountPaidCounter.inc).toHaveBeenCalledTimes(1);
  });

  it('pays a creator whose rows span ClickHouse batches one compensation and one tip transaction', async () => {
    const versionIds = Array.from({ length: 101 }, (_, i) => i + 1);
    mockClickhouseQuery.mockResolvedValue(
      versionIds.map((id) => row(id === 101 ? 'tip' : 'compensation', 'Yellow', 2, id))
    );
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ userId: CREATOR, modelVersionIds: versionIds }]);

    await runPayout(START);

    expect(
      sentTransactions()
        .map(({ externalTransactionId, amount }) => ({ externalTransactionId, amount }))
        .sort((a, b) => a.externalTransactionId.localeCompare(b.externalTransactionId))
    ).toEqual([
      { externalTransactionId: 'creator-tip-comp-2026-10-13-7-Yellow', amount: 200 },
      { externalTransactionId: 'generation-tip-2026-10-13-7-Yellow', amount: 2 },
    ]);
  });
});

describe('the daily job after a failed run', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const at2am = (iso: string) => new Date(`${iso}T02:00:00Z`);

  // The KeyValue row behind getJobDate, and the buzz service's ledger, which dedups on the key alone.
  let lastPayout: Date | undefined;
  let ledger: Map<string, PayoutTransaction>;
  let sendsByKey: Map<string, number>;
  let failDates: Set<string>;
  let queriedDates: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    lastPayout = undefined;
    ledger = new Map();
    sendsByKey = new Map();
    failDates = new Set();
    queriedDates = [];
    loggingMock.logToAxiom.mockClear();

    vi.mocked(getJobDate).mockImplementation(async (_key, defaultValue) => {
      const runStartedAt = new Date();
      return [
        lastPayout ?? defaultValue ?? new Date(0),
        async (date?: Date) => {
          lastPayout = date ?? runStartedAt;
        },
      ] as const;
    });
    mockClickhouseQuery.mockReset();
    mockClickhouseQuery.mockImplementation(async (strings: TemplateStringsArray, ...values) => {
      if (!strings.join('').includes('resourceCompensations')) return [];
      const date = (values[0] as Date).toISOString().slice(0, 10);
      queriedDates.push(date);
      if (failDates.has(date)) throw new Error(`ClickHouse timed out reading ${date}`);
      return [row('compensation', 'Yellow', 50, 11), row('tip', 'Yellow', 6, 11)];
    });
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ userId: CREATOR, modelVersionIds: [11] }]);
    mockCreateBuzzTransactionMany.mockReset();
    mockCreateBuzzTransactionMany.mockImplementation(async (batch: PayoutTransaction[]) => {
      for (const tx of batch) {
        sendsByKey.set(
          tx.externalTransactionId,
          (sendsByKey.get(tx.externalTransactionId) ?? 0) + 1
        );
        if (!ledger.has(tx.externalTransactionId)) ledger.set(tx.externalTransactionId, tx);
      }
      return { transactions: [], conflicts: [] };
    });
  });
  afterEach(() => vi.useRealTimers());

  const runJobAt = async (when: Date) => {
    vi.setSystemTime(when);
    await (updateCreatorResourceCompensation as unknown as { run: () => Promise<void> }).run();
  };
  const paidDates = () =>
    [...new Set([...ledger.keys()].map((key) => key.match(/\d{4}-\d{2}-\d{2}/)![0]))].sort();
  const yellowHeld = () =>
    [...ledger.values()].reduce(
      (sum, tx) => sum + (tx.toAccountType === 'Yellow' ? tx.amount : 0),
      0
    );
  const resentKeys = () => [...sendsByKey].filter(([, sends]) => sends > 1).map(([key]) => key);

  // Before the fix the retry paid the failed run's date and then stamped now(), so the date after it
  // was never paid: 2026-07-05 on prod, paid by hand three weeks late.
  it('a run that fails is made up the next day: both dates are paid, once each', async () => {
    lastPayout = new Date('2026-10-04T02:00:10Z'); // the Oct 4 run paid Oct 3
    failDates.add('2026-10-04');
    await expect(runJobAt(at2am('2026-10-05'))).rejects.toThrow('ClickHouse timed out');
    failDates.clear();

    await runJobAt(at2am('2026-10-06'));
    await runJobAt(at2am('2026-10-07'));

    expect(paidDates()).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(resentKeys()).toEqual([]);
    expect(yellowHeld()).toBe(3 * 56);
  });

  it('a second run on the same day pays nothing', async () => {
    lastPayout = new Date('2026-10-04T02:00:10Z');
    await runJobAt(at2am('2026-10-05'));
    await runJobAt(new Date('2026-10-05T09:30:00Z'));

    expect(paidDates()).toEqual(['2026-10-04']);
    expect(queriedDates).toEqual(['2026-10-04']);
  });

  it('stamps each paid date as it goes, so a run failing part way resumes at the first unpaid date', async () => {
    lastPayout = day('2026-10-01');
    failDates.add('2026-10-02');
    await expect(runJobAt(at2am('2026-10-04'))).rejects.toThrow('ClickHouse timed out');

    expect(paidDates()).toEqual(['2026-10-01']);
    expect(lastPayout).toEqual(day('2026-10-02'));

    failDates.clear();
    queriedDates = [];
    await runJobAt(at2am('2026-10-05'));

    expect(queriedDates).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
    expect(paidDates()).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(resentKeys()).toEqual([]);
  });

  it('catches up across the generation-tip split without paying either day twice', async () => {
    lastPayout = new Date('2026-10-12T02:00:10Z'); // next to pay: Oct 12, the last combined day
    failDates.add('2026-10-12');
    await expect(runJobAt(at2am('2026-10-13'))).rejects.toThrow();
    failDates.clear();

    await runJobAt(at2am('2026-10-14'));

    expect([...ledger.keys()].sort()).toEqual([
      'creator-tip-comp-2026-10-12-7-Yellow',
      'creator-tip-comp-2026-10-13-7-Yellow',
      'generation-tip-2026-10-13-7-Yellow',
    ]);
    expect(ledger.get('creator-tip-comp-2026-10-12-7-Yellow')!.amount).toBe(56);
    expect(yellowHeld()).toBe(2 * 56);
    expect(resentKeys()).toEqual([]);
  });

  it(`pays at most ${MAX_PAYOUT_DATES_PER_RUN} dates in one run and reports the backlog`, async () => {
    lastPayout = day('2026-09-01');
    await runJobAt(at2am('2026-10-01')); // 30 dates due

    expect(paidDates()).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
    ]);
    expect(lastPayout).toEqual(day('2026-09-08'));
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'creator-compensation-backlog',
        details: expect.objectContaining({ datesDue: 30, oldestDue: '2026-09-01' }),
      })
    );
  });

  it('does not report a backlog it does not have', async () => {
    lastPayout = day('2026-09-24');
    await runJobAt(at2am('2026-10-01')); // exactly the cap

    expect(paidDates()).toHaveLength(MAX_PAYOUT_DATES_PER_RUN);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});

// Creator Studio cannot import from src/, so its earnings read spells the prefix out. If the payout
// job's prefix changes and this does not, generation tips silently fall back into compensation there.
describe('Creator Studio earnings classifier', () => {
  it('matches the generation-tip prefix before plain compensation', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../../apps/creator-studio/src/lib/server/earnings.ts'),
      'utf8'
    );
    expect(source).toContain(
      `type = 'tip', 'tip', type = 'compensation' AND externalTransactionId LIKE '${GENERATION_TIP_TRANSACTION_PREFIX}%', 'generationTip', type = 'compensation', 'compensation',`
    );
  });
});
