import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chQuery } = vi.hoisted(() => ({ chQuery: vi.fn() }));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: chQuery },
}));

vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    run: fn,
  }),
}));

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { clickhouseRefreshMonitorJob } from '../clickhouse-refresh-monitor';

type Runnable = { run: (ctx: unknown) => Promise<Result> };
type Result = {
  views?: number;
  missing?: number;
  breached?: string[];
  errored?: string[];
  skipped?: string;
};

const run = () => (clickhouseRefreshMonitorJob as unknown as Runnable).run({});

// prom-client's Metric.get() is async.
const gaugeValues = async (name: string) => {
  const metric = client.register.getSingleMetric(`civitai_app_ch_refresh_${name}`);
  if (!metric) throw new Error(`gauge civitai_app_ch_refresh_${name} is not registered`);
  const { values } = await (
    metric as unknown as {
      get: () => Promise<{ values: { value: number; labels: { view?: string } }[] }>;
    }
  ).get();
  return values;
};

const gaugeFor = async (name: string, view: string) =>
  (await gaugeValues(name)).find((v) => v.labels.view === view)?.value;

const globalGauge = async (name: string) => (await gaugeValues(name))[0]?.value;

const IMPRESSIONS = 'default.impressions_daily_by_owner_mv';
const TRANSACTIONS = 'buzz.transactions_final_mv';

const healthyRow = (view: string, stalenessSeconds: number) => ({
  view,
  status: 'Scheduled',
  exception: '',
  retries: '0',
  stalenessSeconds: String(stalenessSeconds),
});

/**
 * Every monitored view, all fresh. Individual tests replace one row so an assertion
 * about that view cannot be satisfied by a neighbour's value.
 */
const ALL_HEALTHY = [
  healthyRow(TRANSACTIONS, 3),
  healthyRow('default.entityMetricTotal_v3_refresher', 20),
  healthyRow('default.entityMetricTotal_v3_refresher_additive', 30),
  healthyRow('default.entityMetricDaily_today_v2_mv', 90),
  healthyRow('default.entityMetricDailySeal_v2_mv', 20 * 3600),
  healthyRow('default.image_views_daily_by_owner_mv', 20 * 3600),
  healthyRow(IMPRESSIONS, 20 * 3600),
];

const withRow = (view: string, overrides: Record<string, unknown>) =>
  ALL_HEALTHY.map((row) => (row.view === view ? { ...row, ...overrides } : row));

beforeEach(() => {
  vi.clearAllMocks();
  chQuery.mockResolvedValue(ALL_HEALTHY);
});

describe('clickhouse-refresh-monitor', () => {
  it('reports every monitored view healthy and logs nothing when all are fresh', async () => {
    const result = await run();

    expect(result.views).toBe(7);
    expect(result.missing).toBe(0);
    expect(result.breached).toEqual([]);
    expect(result.errored).toEqual([]);
    expect(await gaugeFor('staleness_seconds', IMPRESSIONS)).toBe(20 * 3600);
    expect(await globalGauge('views_missing')).toBe(0);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  /**
   * The failure this job exists for. `status` and `exception` both look fine; only the
   * elapsed time moves. A version that alerted off `errored` would pass every other test
   * in this file and miss exactly this.
   */
  it('flags a view that is stuck without erroring', async () => {
    chQuery.mockResolvedValue(withRow(TRANSACTIONS, { stalenessSeconds: '600' }));

    const result = await run();

    expect(result.breached).toEqual([TRANSACTIONS]);
    expect(result.errored).toEqual([]);
    expect(await gaugeFor('errored', TRANSACTIONS)).toBe(0);
    expect(await gaugeFor('staleness_seconds', TRANSACTIONS)).toBe(600);
    expect(await gaugeFor('staleness_limit_seconds', TRANSACTIONS)).toBe(300);
  });

  it('publishes a limit for every view that its healthy staleness stays under', async () => {
    await run();

    for (const row of ALL_HEALTHY) {
      const limit = await gaugeFor('staleness_limit_seconds', row.view);
      expect(limit, `no limit published for ${row.view}`).toBeGreaterThan(
        Number(row.stalenessSeconds)
      );
    }
  });

  /**
   * A dropped or renamed view stops appearing in system.view_refreshes. Its gauge would
   * otherwise keep the last healthy number forever and resolve a firing alert.
   */
  it('treats an absent view as maximally stale rather than leaving its last value', async () => {
    chQuery.mockResolvedValue(ALL_HEALTHY.filter((row) => row.view !== IMPRESSIONS));

    const result = await run();

    expect(result.missing).toBe(1);
    expect(await gaugeFor('present', IMPRESSIONS)).toBe(0);
    expect(await globalGauge('views_missing')).toBe(1);

    const staleness = await gaugeFor('staleness_seconds', IMPRESSIONS);
    const limit = await gaugeFor('staleness_limit_seconds', IMPRESSIONS);
    expect(staleness).toBeGreaterThan(limit as number);
    expect(result.breached).toContain(IMPRESSIONS);
  });

  it('treats a view that has never refreshed successfully as maximally stale', async () => {
    chQuery.mockResolvedValue(withRow(IMPRESSIONS, { stalenessSeconds: null }));

    const result = await run();

    expect(result.breached).toContain(IMPRESSIONS);
    expect(await gaugeFor('present', IMPRESSIONS)).toBe(1);
    expect(await gaugeFor('staleness_seconds', IMPRESSIONS)).toBeGreaterThan(
      (await gaugeFor('staleness_limit_seconds', IMPRESSIONS)) as number
    );
  });

  it('surfaces an exception and its retry count without waiting for staleness', async () => {
    const exception = 'DB::Exception: Memory limit (total) exceeded';
    chQuery.mockResolvedValue(withRow(TRANSACTIONS, { exception, retries: '4' }));

    const result = await run();

    expect(result.errored).toEqual([TRANSACTIONS]);
    expect(result.breached).toEqual([]);
    expect(await gaugeFor('errored', TRANSACTIONS)).toBe(1);
    expect(await gaugeFor('retries', TRANSACTIONS)).toBe(4);
    // The whole reason this job logs at all: no gauge can carry the exception text, and
    // an on-call told only "view X is errored" has to go re-query ClickHouse by hand.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining(exception) })
    );
  });

  it('escalates to error level only for a breached page-severity view', async () => {
    chQuery.mockResolvedValue(withRow(TRANSACTIONS, { stalenessSeconds: '600' }));
    await run();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));

    vi.clearAllMocks();
    chQuery.mockResolvedValue(withRow(IMPRESSIONS, { stalenessSeconds: String(30 * 3600) }));
    await run();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error' })
    );
  });

  /**
   * The flag is the target ENGINE, not whether the refresh appends. Six of the seven
   * append; only the two SummingMergeTree targets double on a re-run. Marking it by APPEND
   * would set this on `transactions_final_mv`, whose ReplacingMergeTree target dedupes.
   */
  it('marks only the views whose target double-counts on a re-run', async () => {
    await run();

    expect(await gaugeFor('unrepairable_by_rerun', IMPRESSIONS)).toBe(1);
    expect(await gaugeFor('unrepairable_by_rerun', 'default.image_views_daily_by_owner_mv')).toBe(
      1
    );
    expect(await gaugeFor('unrepairable_by_rerun', TRANSACTIONS)).toBe(0);
    expect(await gaugeFor('unrepairable_by_rerun', 'default.entityMetricDailySeal_v2_mv')).toBe(0);
  });

  /**
   * The anchor is what an operator alerts on to know the monitor itself is alive, so a run
   * that published no view gauges must not advance it — that would report a healthy monitor
   * standing over numbers from an earlier run.
   */
  it('does not advance its own liveness anchor when ClickHouse returns nothing', async () => {
    await run();
    const anchor = await globalGauge('monitor_last_run_timestamp_seconds');

    chQuery.mockResolvedValue(undefined);
    // Fake timers, because both runs otherwise land inside the same millisecond and
    // `toBe(anchor)` is satisfied by a mutant that stamps the anchor unconditionally.
    // Verified: without this, moving the `set` to the top of the job passes all 9 tests.
    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);
    try {
      const result = await run();
      expect(result.skipped).toBe('clickhouse-unavailable');
      expect(await globalGauge('monitor_last_run_timestamp_seconds')).toBe(anchor);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The client sets `output_format_json_quote_64bit_integers: 0`, so production returns
   * plain numbers; every other fixture here uses the quoted shape the `string | number`
   * union defends against. Without this the tests exercise only the branch that does not
   * occur in production.
   */
  it('reads the unquoted numeric shape ClickHouse actually returns', async () => {
    chQuery.mockResolvedValue(
      ALL_HEALTHY.map((row) => ({
        ...row,
        retries: Number(row.retries),
        stalenessSeconds: row.view === TRANSACTIONS ? 600 : Number(row.stalenessSeconds),
      }))
    );

    const result = await run();

    expect(result.breached).toEqual([TRANSACTIONS]);
    expect(await gaugeFor('staleness_seconds', TRANSACTIONS)).toBe(600);
    expect(await gaugeFor('retries', TRANSACTIONS)).toBe(0);
  });
});
