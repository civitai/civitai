import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisClient from '~/server/redis/client';

const { mockAuditHour, mockAuditExactness,   } =
  vi.hoisted(() => ({
    mockAuditHour: vi.fn(),
    mockAuditExactness: vi.fn(),
    
    
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
vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: (ctx: unknown) => Promise<unknown>) => ({
    run: fn,
  }),
}));

import { reactionExactnessAuditJob, reactionVolumeAuditJob } from '../metric-reconciliation-audit';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockRedisGet = redisMock.sysRedis.get;
const mockRedisSet = redisMock.sysRedis.set;
const mockLogToAxiom = loggingMock.logToAxiom;

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
  it('re-publishes the nightly run time, never the re-publish time', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify(STORED_SNAPSHOT));

    await runHourly();

    // Asserted as an age, which fails as "expected 0 to be greater than 126000" rather
    // than as two 10-digit timestamps that differ.
    const ageSeconds =
      Date.now() / 1000 - ((await gaugeValue('exactness_last_run_timestamp_seconds')) ?? 0);
    expect(ageSeconds).toBeGreaterThan(35 * 3600);
    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0.9997);
  });

  // An unset gauge and a measured 0.0 are byte-identical on the scrape, so these two
  // cases agree on the coverage value and are told apart only by recent_pairs.
  it('separates an unmeasured sample from a measured total loss', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({ ...STORED_SNAPSHOT, recentCoverage: null, recentPairs: 0 })
    );
    await runHourly();
    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0);
    expect(await gaugeValue('exactness_recent_pairs')).toBe(0);

    mockRedisGet.mockResolvedValue(
      JSON.stringify({ ...STORED_SNAPSHOT, recentCoverage: 0, recentPairs: 412 })
    );
    await runHourly();
    expect(await gaugeValue('exactness_recent_coverage_ratio')).toBe(0);
    expect(await gaugeValue('exactness_recent_pairs')).toBe(412);
  });

  /**
   * The re-publish awaits, so /api/metrics can be served mid-call. Between a fresh anchor
   * and an unset coverage gauge a scrape reads 0 as total CDC loss. Only the ordering
   * pins this — the gauge values at the end of the run are identical either way.
   */
  it('sets the coverage gauge before the anchor, and re-publishes after both', async () => {
    const order: string[] = [];
    mockRedisGet.mockImplementation(async () => {
      order.push('republish');
      return JSON.stringify(STORED_SNAPSHOT);
    });
    const spies = (['hourly_coverage_ratio', 'audit_last_run_timestamp_seconds'] as const).map(
      (name) => {
        const g = client.register.getSingleMetric(`civitai_app_reaction_${name}`) as unknown as {
          set: (v: number) => void;
        };
        const real = g.set.bind(g);
        return vi.spyOn(g, 'set').mockImplementation((v) => {
          order.push(name === 'hourly_coverage_ratio' ? 'coverage' : 'anchor');
          real(v);
        });
      }
    );

    try {
      await runHourly();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect(order).toEqual(['coverage', 'anchor', 'republish']);
  });

  it('refuses a malformed snapshot instead of publishing a partial one', async () => {
    const { recentPairs: _dropped, ...missingField } = STORED_SNAPSHOT;
    mockRedisGet.mockResolvedValue(JSON.stringify(missingField));

    const result = (await runHourly()) as { coverage: number | null };

    expect(result.coverage).toBe(1);
    expect(await gaugeValue('exactness_last_run_timestamp_seconds')).toBe(0);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'reaction-exactness-republish', level: 'error' })
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

  it('persists its result with no TTL, so expiry cannot resolve a firing alert', async () => {
    mockAuditExactness.mockResolvedValue(EXACTNESS_RESULT);

    await runNightly();

    const [key, payload, options] = mockRedisSet.mock.calls[0];
    expect(key).toBe('metric-reconciliation:nightly-exactness');
    expect(options).toBeUndefined();
    expect(JSON.parse(payload)).toMatchObject({ recentCoverage: 1, recentPairs: 500 });
  });
});
