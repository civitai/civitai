import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => true),
  fetch: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mocks.isFlipt,
  FLIPT_FEATURE_FLAGS: { AUTO_FEATURE_IMAGES: 'auto-feature-images' },
}));
// LOGGING is read by createLogger at module load; the webhook is the only value asserted on.
vi.mock('~/env/server', () => ({
  env: { DISCORD_WEBHOOK_MOD_ALERTS: 'https://discord.test/webhook', LOGGING: [] },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

import {
  autoFeatureHealthCheckJob,
  evaluateAutoFeatureHealth,
  readAutoFeatureHealth,
} from '~/server/jobs/auto-feature-health-check';
import { AUTO_FEATURE_JOB_DATE_KEY } from '~/server/common/auto-feature';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const NOW = new Date('2026-09-01T18:00:00Z');
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Today's production config: 6h interval, live writes, target collection 107. */
const CONFIG = { collectionId: 107, intervalHours: 6, dryRun: false, perRun: 5 };

/**
 * Drives the job's three reads: the home block's config, the `KeyValue` heartbeat, and the raw
 * `max(...)` over the target collection. Declared per-test rather than defaulted to healthy, so a
 * test that forgets to say what the database holds fails rather than inheriting a green.
 */
function stateIs({
  config = CONFIG as Record<string, unknown> | null,
  lastRun,
  lastRow,
}: {
  config?: Record<string, unknown> | null;
  lastRun: Date | null;
  lastRow: Date | null;
}) {
  dbMock.dbRead.homeBlock.findFirst.mockResolvedValue(
    config === null ? null : { metadata: { featuredCollections: { autoFeature: config } } }
  );
  dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 9001 });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(
    lastRun === null ? null : { key: AUTO_FEATURE_JOB_DATE_KEY, value: lastRun.getTime() }
  );
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ lastRow }]);
}

/** The tagged-template args the job hands the database: [strings, ...binds]. */
function rowQuery() {
  const [strings, ...binds] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
  return { sql: strings.join('?'), binds };
}

function axiom(type: 'warning' | 'info') {
  return loggingMock.logToAxiom.mock.calls
    .map(([arg]) => arg as { type?: string; name?: string; message?: string })
    .filter((arg) => arg.name === 'auto-feature-health-check' && arg.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.isFlipt.mockResolvedValue(true);
});

describe('auto-feature-health-check reads state the producer does not have to be alive for', () => {
  it('watches the same KeyValue row the job advances', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(1) });

    await autoFeatureHealthCheckJob.run();

    // Pinned as a literal, not as the shared constant: the value lives in a production table, so a
    // rename has to be a deliberate edit here rather than a silent rename on both sides that
    // leaves the check watching a key nothing writes.
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledWith({
      where: { key: 'job:auto-feature-images' },
    });
  });

  it('dates a row the way the producer does, by COALESCE rather than one column', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(1) });

    await autoFeatureHealthCheckJob.run();

    const { sql, binds } = rowQuery();
    // max(reviewedAt) and max(createdAt) taken separately are a different value, and agree only
    // while reviewedAt happens to be null — which is exactly how this would pass in a test and
    // drift in production.
    expect(sql).toMatch(/max\(COALESCE\(ci\."reviewedAt", ci\."createdAt"\)\)/);
    // Scoped to the job's own rows: a curator's manual feature must not answer "the job is alive".
    expect(binds).toContain(107);
    expect(binds).toContain(9001);
    expect(binds).toContain('auto-featured:%');
  });

  it('derives the threshold from the configured interval rather than a constant', async () => {
    stateIs({ config: { ...CONFIG, intervalHours: 6 }, lastRun: NOW, lastRow: NOW });
    const at6 = await readAutoFeatureHealth();

    stateIs({ config: { ...CONFIG, intervalHours: 24 }, lastRun: NOW, lastRow: NOW });
    const at24 = await readAutoFeatureHealth();

    // The cadence is tunable without a deploy, so a hardcoded threshold silently stops matching it.
    expect(at6.staleAfterHours).toBe(13);
    expect(at24.staleAfterHours).toBe(49);
  });

  it('still checks when the config has gone missing, at the schema default cadence', async () => {
    stateIs({ config: null, lastRun: hoursBefore(80), lastRow: hoursBefore(80) });

    const result = await autoFeatureHealthCheckJob.run();

    // A vanished config is itself a fault the producer cannot report while it is not running.
    // Refusing to check without one would blind this job to precisely that case.
    expect(result).toMatchObject({ healthy: false, staleAfterHours: 13 });
  });
});

describe('auto-feature-health-check alerting', () => {
  it('stays quiet on a live pipeline', async () => {
    stateIs({ lastRun: hoursBefore(0.7), lastRow: hoursBefore(0.7) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: true });
    expect(axiom('warning')).toHaveLength(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('pages on a repeat of the 79-hour August outage', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, paged: 1 });
    expect(axiom('warning')[0].message).toContain('Not running');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('pages when the job has never run at all', async () => {
    // A missing heartbeat and a months-old one are the same outage from the homepage's side.
    // Treating null as inconclusive is how a check that cannot fire gets written.
    stateIs({ lastRun: null, lastRow: null });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, paged: 1 });
    expect(axiom('warning')[0].message).toContain('Not running');
  });

  it('does not page on the ordinary 7-hour spacing between runs', async () => {
    // The producer wakes hourly and fires on a 6h interval, so 7h is the real observed gap. A
    // threshold at or below it would page several times a day and be turned off.
    stateIs({ lastRun: hoursBefore(7), lastRow: hoursBefore(7) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('records a running-but-dry pipeline without paging for it', async () => {
    stateIs({ lastRun: hoursBefore(1), lastRow: hoursBefore(40) });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, alerts: 1, paged: 0 });
    expect(axiom('info')[0].message).toContain('Running but not writing');
    // Caps refusing everything is legitimate. Paging on it is how an alert gets muted.
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('blames a dead job once, not twice', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });

    const result = await autoFeatureHealthCheckJob.run();

    // The rows are stale BECAUSE the job is dead. A second line naming the caps would name a
    // cause that is not the one, and send whoever reads it to the wrong place.
    expect(result).toMatchObject({ alerts: 1 });
    expect(axiom('warning')[0].message).not.toContain('Running but not writing');
  });

  it('does not treat a dry run as a stopped one', async () => {
    stateIs({ config: { ...CONFIG, dryRun: true }, lastRun: hoursBefore(1), lastRow: null });

    const result = await autoFeatureHealthCheckJob.run();

    // dryRun writes nothing by design, so the row check has nothing to say. The heartbeat still does.
    expect(result).toMatchObject({ healthy: true });
  });

  it('still pages a dry-run pipeline whose job has stopped', async () => {
    stateIs({ config: { ...CONFIG, dryRun: true }, lastRun: hoursBefore(79), lastRow: null });

    const result = await autoFeatureHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, paged: 1 });
  });

  it('skips entirely when the auto-feature flag is off', async () => {
    stateIs({ lastRun: hoursBefore(79), lastRow: hoursBefore(79) });
    mocks.isFlipt.mockResolvedValue(false);

    const result = await autoFeatureHealthCheckJob.run();

    // The flag off makes the producer return before it touches anything, by design.
    expect(result).toMatchObject({ skipped: true });
    expect(dbMock.dbRead.keyValue.findUnique).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('evaluateAutoFeatureHealth boundary', () => {
  const base = { staleAfterHours: 13, dryRun: false, collectionId: 107 };

  it('is quiet at the threshold and fires one hour past it', () => {
    const at = evaluateAutoFeatureHealth(
      { ...base, lastRun: hoursBefore(13), lastRow: hoursBefore(13) },
      NOW
    );
    const past = evaluateAutoFeatureHealth(
      { ...base, lastRun: hoursBefore(14), lastRow: hoursBefore(14) },
      NOW
    );

    expect(at).toHaveLength(0);
    expect(past.map((a) => a.severity)).toEqual(['page']);
  });
});
