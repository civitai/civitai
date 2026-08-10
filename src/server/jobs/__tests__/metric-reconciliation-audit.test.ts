import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisClient from '~/server/redis/client';

const { mockAuditHour, mockAuditExactness, mockRedisGet, mockRedisSet, mockLogToAxiom } =
  vi.hoisted(() => ({
    mockAuditHour: vi.fn(),
    mockAuditExactness: vi.fn(),
    mockRedisGet: vi.fn(),
    mockRedisSet: vi.fn(),
    mockLogToAxiom: vi.fn(),
  }));

vi.mock('~/server/services/metric-reconciliation.service', () => ({
  auditReactionHour: mockAuditHour,
  auditReactionExactness: mockAuditExactness,
  requestReactionRepair: vi.fn().mockResolvedValue(false),
  setReactionRepairHook: vi.fn(),
}));
vi.mock('~/server/services/metric-reaction-repair.service', () => ({
  repairReactionMetrics: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: { METRIC_REACTION_REPAIR: 'metric-reaction-repair' },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

// Spread the real module so REDIS_SYS_KEYS stays authoritative — a hand-written
// key here would let the job and the test agree on a key production never uses.
vi.mock('~/server/redis/client', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisClient>()),
  sysRedis: { get: mockRedisGet, set: mockRedisSet },
}));

vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    run: fn,
  }),
}));

import { reactionExactnessAuditJob, reactionVolumeAuditJob } from '../metric-reconciliation-audit';

type Runnable = { run: (ctx: unknown) => Promise<unknown> };
const jobContext = { checkIfCanceled: () => undefined };
const runHourly = () => (reactionVolumeAuditJob as unknown as Runnable).run(jobContext);
const runNightly = () => (reactionExactnessAuditJob as unknown as Runnable).run(jobContext);

// prom-client's Metric.get() is async.
const gaugeValue = async (name: string) => {
  const metric = client.register.getSingleMetric(`civitai_app_reaction_${name}`);
  if (!metric) throw new Error(`gauge civitai_app_reaction_${name} is not registered`);
  const { values } = await (
    metric as unknown as { get: () => Promise<{ values: { value: number }[] }> }
  ).get();
  return values[0]?.value;
};

const HEALTHY_HOUR = {
  hourStart: new Date('2026-08-10T12:00:00Z'),
  pgRows: 24000,
  matched: 24000,
  missing: 0,
  coverage: 1,
  unknownReactions: {},
  affectedImageIds: [],
  durationMs: 1200,
};

// A day and a half before "now" in the tests below. Far enough that a re-publish
// that re-stamped the timestamp would be off by a value no rounding explains.
const NIGHTLY_RAN_AT = Math.floor(Date.now() / 1000) - 36 * 3600;
const STORED_SNAPSHOT = {
  ranAt: NIGHTLY_RAN_AT,
  recentCoverage: 0.9997,
  backlogCoverage: 0.9612,
  phantomRate: 0.0037,
  recentPairs: 464,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditHour.mockResolvedValue(HEALTHY_HOUR);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockLogToAxiom.mockResolvedValue(undefined);
  for (const name of [
    'exactness_recent_coverage_ratio',
    'exactness_backlog_coverage_ratio',
    'exactness_phantom_ratio',
    'exactness_last_run_timestamp_seconds',
    'exactness_recent_pairs',
    'hourly_coverage_ratio',
    'audit_last_run_timestamp_seconds',
  ]) {
    client.register.getSingleMetric(`civitai_app_reaction_${name}`)?.reset();
  }
});

describe('nightly exactness gauges survive a pod roll', () => {
  it('re-publishes the stored nightly result from the hourly job', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify(STORED_SNAPSHOT));

    await runHourly();

    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0.9997);
    expect(await gaugeValue('exactness_backlog_coverage_ratio')).toBe(0.9612);
    expect(await gaugeValue('exactness_phantom_ratio')).toBe(0.0037);
  });

  /**
   * The whole point of the mechanism. Re-publishing the values is only safe if the
   * freshness stamp keeps pointing at the nightly's own run: stamp it at re-publish
   * and a nightly that died weeks ago reports itself alive every hour, which is worse
   * than the `No data` this replaced — silence at least does not lie.
   */
  it('re-publishes the nightly run time, never the re-publish time', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify(STORED_SNAPSHOT));

    await runHourly();

    // Asserted as an age FIRST, and deliberately so: it fails with "expected 0.04 to
    // be greater than 126000", which names the regression. The exact-equality check
    // below fails with two 10-digit unix timestamps, which does not.
    const ageSeconds =
      Date.now() / 1000 - ((await gaugeValue('exactness_last_run_timestamp_seconds')) ?? 0);
    expect(ageSeconds).toBeGreaterThan(35 * 3600);
    expect(await gaugeValue('exactness_last_run_timestamp_seconds')).toBe(NIGHTLY_RAN_AT);
  });

  it('publishes nothing when no nightly result has been stored yet', async () => {
    mockRedisGet.mockResolvedValue(null);

    await runHourly();

    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0);
    expect(await gaugeValue('exactness_last_run_timestamp_seconds')).toBe(0);
  });

  /**
   * An unset gauge and a measured 0.0 are byte-identical on the scrape, so asserting
   * `toBe(0)` here proves nothing — it passes whether the null is skipped or published
   * as a zero. `recentPairs` is the only thing that separates the two states, so that
   * is what this asserts. The pair of tests below is the real coverage: same gauge
   * value, opposite meaning, told apart by the companion gauge.
   */
  it('marks a null recent arm as UNMEASURED via recent_pairs', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({ ...STORED_SNAPSHOT, recentCoverage: null, recentPairs: 0 })
    );

    await runHourly();

    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0);
    expect(await gaugeValue('exactness_recent_pairs')).toBe(0);
    expect(await gaugeValue('exactness_backlog_coverage_ratio')).toBe(0.9612);
  });

  it('marks a measured total loss as MEASURED, at the same gauge value', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({ ...STORED_SNAPSHOT, recentCoverage: 0, recentPairs: 412 })
    );

    await runHourly();

    // Identical to the test above — which is the point.
    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0);
    // ...and this is what makes it a total loss rather than an empty sample.
    expect(await gaugeValue('exactness_recent_pairs')).toBe(412);
  });

  /**
   * The re-publish is an `await`, so the process can serve /api/metrics from the same
   * prom registry while it is pending. If it sits between the anchor set and the value
   * set, a scrape in that window on a pod's first run after a roll sees a fresh anchor
   * beside a coverage gauge still at prom-client's default 0, and the freshest-pod query
   * reads that 0 as a total CDC loss. Asserting the ordering directly is the only way to
   * pin it — the gauge values at the END of the run are identical either way.
   */
  it('sets the hourly coverage gauge BEFORE the anchor, and re-publishes after both', async () => {
    const order: string[] = [];
    mockRedisGet.mockImplementation(async () => {
      order.push('republish');
      return JSON.stringify(STORED_SNAPSHOT);
    });
    const gauge = (name: string) =>
      client.register.getSingleMetric(`civitai_app_reaction_${name}`) as unknown as {
        set: (v: number) => void;
      };
    const coverage = gauge('hourly_coverage_ratio');
    const anchor = gauge('audit_last_run_timestamp_seconds');
    const realCoverage = coverage.set.bind(coverage);
    const realAnchor = anchor.set.bind(anchor);
    const spyCoverage = vi.spyOn(coverage, 'set').mockImplementation((v) => {
      order.push('coverage');
      realCoverage(v);
    });
    const spyAnchor = vi.spyOn(anchor, 'set').mockImplementation((v) => {
      order.push('anchor');
      realAnchor(v);
    });

    try {
      await runHourly();
    } finally {
      spyCoverage.mockRestore();
      spyAnchor.mockRestore();
    }

    expect(order).toEqual(['coverage', 'anchor', 'republish']);
  });

  /**
   * `JSON.parse(raw) as T` cannot catch a shape change. `undefined !== null` is true, so
   * a field missing after a deploy reaches `gauge.set(undefined)`, which THROWS — and the
   * caller's catch then swallows it, publishing no gauges at all while the hourly audit
   * reports success. Validation turns that into a logged refusal.
   */
  it('refuses a malformed snapshot instead of publishing a partial one', async () => {
    const { recentPairs: _dropped, ...missingField } = STORED_SNAPSHOT;
    mockRedisGet.mockResolvedValue(JSON.stringify(missingField));

    const result = (await runHourly()) as { coverage: number | null };

    expect(result.coverage).toBe(1);
    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0);
    expect(await gaugeValue('exactness_last_run_timestamp_seconds')).toBe(0);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'reaction-exactness-republish', level: 'error' })
    );
  });

  it('logs rather than swallows a Redis read failure', async () => {
    mockRedisGet.mockRejectedValue(new Error('ECONNREFUSED'));

    await runHourly();

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'reaction-exactness-republish', level: 'warn' })
    );
  });

  it('still completes the hourly audit when Redis is unreachable', async () => {
    mockRedisGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = (await runHourly()) as { coverage: number | null };

    expect(result.coverage).toBe(1);
  });
});

describe('nightly exactness audit', () => {
  const EXACTNESS_RESULT = {
    imagesSampled: 200,
    imagesDeleted: 3,
    pairsChecked: 8000,
    pairsExact: 7990,
    missingInCh: 0,
    phantomInCh: 10,
    coverage: 0.98,
    recentCoverage: 1,
    backlogCoverage: 0.9612,
    recentPairs: 500,
    backlogPairs: 7500,
    phantomRate: 0.00125,
    affectedImageIds: [],
    durationMs: 5000,
  };

  it('persists its result so the hourly job can re-publish it', async () => {
    mockAuditExactness.mockResolvedValue(EXACTNESS_RESULT);

    await runNightly();

    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, payload, options] = mockRedisSet.mock.calls[0];
    expect(key).toBe('metric-reconciliation:nightly-exactness');
    expect(JSON.parse(payload)).toMatchObject({
      recentCoverage: 1,
      backlogCoverage: 0.9612,
      phantomRate: 0.00125,
      recentPairs: 500,
    });
    expect(options).toBeUndefined();
  });

  it('stamps the snapshot with its own completion time', async () => {
    mockAuditExactness.mockResolvedValue(EXACTNESS_RESULT);
    const before = Date.now() / 1000;

    await runNightly();

    const { ranAt } = JSON.parse(mockRedisSet.mock.calls[0][1]);
    expect(ranAt).toBeGreaterThanOrEqual(before);
    expect(await gaugeValue('exactness_last_run_timestamp_seconds')).toBe(ranAt);
  });

  it('does not fail the audit when the snapshot write fails', async () => {
    mockAuditExactness.mockResolvedValue(EXACTNESS_RESULT);
    mockRedisSet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = (await runNightly()) as { recentCoverage: number | null };

    expect(result.recentCoverage).toBe(1);
    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(1);
  });
});
