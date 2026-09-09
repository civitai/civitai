import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE SEAM, NOT EITHER SIDE OF IT.
 *
 * appListing.metrics.test.ts proves the soft-degrade POLICY (a query rejection
 * degrades; a builder or mapping throw propagates). appListing.metrics.prom.test.ts
 * proves the SIGNAL exists on the registry `/api/metrics` scrapes and increments.
 * Both pass with the processor's `onDegrade` never calling the emitter at all — the
 * counter would be a correct, registered, permanently-zero series, and "blipped
 * once" vs "dead for a week" would still be indistinguishable, which is the entire
 * reason the counter was added.
 *
 * So this file drives the REAL `appListingMetrics.update()` with a real (unmocked)
 * `appListing.metrics.sql` and a real prom registry, and mocks only the infra edges
 * the processor talks to: ClickHouse, Postgres, the job-date/queue plumbing.
 */

const { chQuery, pgCancellableQuery } = vi.hoisted(() => ({
  chQuery: vi.fn(),
  pgCancellableQuery: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { query: chQuery } }));
vi.mock('~/server/jobs/job', () => ({
  // An hour ago, so base.metrics' `shouldUpdate` gate is open.
  getJobDate: async () => [new Date(Date.now() - 3_600_000), async () => undefined],
}));
vi.mock('~/server/redis/queues', () => ({
  checkoutQueue: async () => ({ content: [], commit: async () => undefined }),
  addToQueue: async () => undefined,
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbWrite: { cancellableQuery: pgCancellableQuery },
  pgDbRead: { cancellableQuery: pgCancellableQuery },
  pgDbReadLong: { cancellableQuery: pgCancellableQuery },
}));

import { appListingMetrics } from '../appListing.metrics';

const METRIC = 'civitai_app_listing_open_discovery_degraded_total';
const jobContext = { checkIfCanceled: () => undefined, on: () => undefined } as never;

/** A @clickhouse/client ResultSet stand-in. */
const chRows = (rows: unknown[]) => ({ json: async () => rows });
/** A pg `cancellableQuery` stand-in. */
const pgRows = (rows: unknown[]) => ({ result: async () => rows, cancel: async () => undefined });

async function degradeCount(): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  return (await metric.get()).values[0]?.value ?? Number.NaN;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `resetMetrics()`, NOT `removeSingleMetric()`: the counter is registered eagerly
  // at the prom module's scope (which this file's import of the processor pulls in),
  // and removing it would delete exactly the "healthy pod reports 0" property the
  // negative control below is asserting.
  client.register.resetMetrics();
});

describe('appListingMetrics.update — the degrade signal is actually wired', () => {
  it('🔴 a ClickHouse DISCOVERY failure increments the counter AND the run continues', async () => {
    // The regression the soft path exists to prevent is `install_count` being held
    // hostage by a ClickHouse blip, so both halves are asserted together: the signal
    // fires, and the Postgres affected-set query still runs.
    chQuery.mockRejectedValue(new Error('MEMORY_LIMIT_EXCEEDED'));
    pgCancellableQuery.mockResolvedValue(pgRows([]));

    await expect(appListingMetrics.update(jobContext)).resolves.toBeUndefined();

    expect(await degradeCount()).toBe(1);
    expect(pgCancellableQuery).toHaveBeenCalledTimes(1);
    expect(pgCancellableQuery.mock.calls[0][0]).toContain('app_listings');
  });

  it('🔴 NEGATIVE CONTROL: a HEALTHY run leaves the counter at 0', async () => {
    // Without this the counter could be incremented unconditionally — a series that
    // is always non-zero cannot distinguish a degrade from a normal cycle, which is
    // the same blindness with the opposite sign.
    chQuery
      .mockResolvedValueOnce(chRows([{ appBlockId: 'apb_x' }])) // discovery
      .mockResolvedValueOnce(chRows([{ appBlockId: 'apb_x', openCount: 4 }])); // count
    pgCancellableQuery
      .mockResolvedValueOnce(pgRows([{ id: 'apl_1', app_block_id: 'apb_x' }])) // affected
      .mockResolvedValueOnce(pgRows([])); // upsert

    await appListingMetrics.update(jobContext);

    expect(await degradeCount()).toBe(0);
    // Positive control on the fixture: the run really did do its work, so the 0
    // above is "nothing degraded", not "nothing ran".
    expect(chQuery).toHaveBeenCalledTimes(2);
    expect(pgCancellableQuery).toHaveBeenCalledTimes(2);
    expect(pgCancellableQuery.mock.calls[1][0]).toContain('ON CONFLICT');
  });

  it('🔴 the COUNT read fails HARD and does NOT touch the degrade counter', async () => {
    // The asymmetry, at the seam: `open_count` is derived, so a partial count map is
    // written over live counts as 0. That must fail the run, not degrade it — and it
    // must not be reported on the counter that means "we degraded and carried on".
    chQuery
      .mockResolvedValueOnce(chRows([{ appBlockId: 'apb_x' }])) // discovery succeeds
      .mockRejectedValueOnce(new Error('Code: 62. DB::Exception: Max query size exceeded'));
    pgCancellableQuery.mockResolvedValueOnce(pgRows([{ id: 'apl_1', app_block_id: 'apb_x' }]));

    await expect(appListingMetrics.update(jobContext)).rejects.toThrow('Code: 62');

    expect(await degradeCount()).toBe(0);
    // No upsert ran — the counts stay at their last good values.
    expect(pgCancellableQuery).toHaveBeenCalledTimes(1);
  });
});
