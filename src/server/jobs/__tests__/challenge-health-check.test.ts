import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => true),
  fetch: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mocks.isFlipt,
  FLIPT_FEATURE_FLAGS: { CHALLENGE_PLATFORM_ENABLED: 'challenge-platform-enabled' },
}));
// LOGGING is read by createLogger at module load, so it has to be here even though the alert
// webhook is the only value this suite cares about.
vi.mock('~/env/server', () => ({
  env: { DISCORD_WEBHOOK_MOD_ALERTS: 'https://discord.test/webhook', LOGGING: [] },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

import { challengeHealthCheckJob } from '~/server/jobs/challenge-health-check';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

type Health = {
  hasUpcoming: boolean;
  hasRecent: boolean;
  nextScheduledAt: Date | null;
  lastActivatedAt: Date | null;
};

const healthy: Health = {
  hasUpcoming: true,
  hasRecent: true,
  nextScheduledAt: new Date('2026-09-01T00:00:00Z'),
  lastActivatedAt: new Date('2026-08-31T00:00:00Z'),
};

function answerWith(row: Partial<Health>) {
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ ...healthy, ...row }]);
}

/** The tagged-template args the job actually hands the database: [strings, ...binds]. */
function queryCall() {
  const [strings, ...binds] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
  return { sql: strings.join('?'), binds };
}

function warnings() {
  return loggingMock.logToAxiom.mock.calls
    .map(([arg]) => arg as { type?: string; name?: string; message?: string })
    .filter((arg) => arg.name === 'challenge-health-check' && arg.type === 'warning');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.isFlipt.mockResolvedValue(true);
  answerWith({});
});

describe('challenge-health-check query shape', () => {
  // The 2026-08-28..31 false alarms were entirely inside this SQL, so mocking $queryRaw cannot
  // reach them. What IS reachable is the arguments the job sends: assert those, not the constants,
  // so a revert of either decision fails here rather than in Discord four hours later.
  it('gives the recent-start window more than the 24h challenge cadence', async () => {
    await challengeHealthCheckJob.run();

    const { binds } = queryCall();
    const windowHours = binds.find((b) => typeof b === 'number' && b !== 48);
    expect(windowHours).toBeGreaterThan(24);
  });

  it('counts a started challenge in any post-activation state, never Scheduled', async () => {
    await challengeHealthCheckJob.run();

    const statuses = queryCall().binds.find(Array.isArray) as string[];
    // Scheduled past its own startsAt is the failure this job watches for — counting it would
    // make the check unfalsifiable.
    expect(statuses).not.toContain('Scheduled');
    // The outgoing challenge is routinely mid-completion when this job reads at the 00:00 tick.
    expect(statuses).toEqual(expect.arrayContaining(['Active', 'Completing', 'Completed']));
  });

  it('drives the recent-start check off that status list, not an Active literal', async () => {
    await challengeHealthCheckJob.run();

    const hasRecentArm = queryCall().sql.split('AS "hasUpcoming"')[1].split('AS "hasRecent"')[0];
    expect(hasRecentArm).not.toMatch(/status\s*=\s*'Active'/);
    expect(hasRecentArm).toMatch(/status::text\s*=\s*ANY\(/);
  });
});

describe('challenge-health-check alerting', () => {
  it('stays quiet when a challenge started and one is scheduled', async () => {
    const result = await challengeHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: true });
    expect(warnings()).toHaveLength(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('alerts when nothing started inside the window', async () => {
    answerWith({ hasRecent: false, lastActivatedAt: null });

    const result = await challengeHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, failures: 1 });
    expect(warnings()[0].message).toContain('Not started');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('alerts when the schedule ahead is empty', async () => {
    answerWith({ hasUpcoming: false, nextScheduledAt: null });

    const result = await challengeHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, failures: 1 });
    expect(warnings()[0].message).toContain('Not prepared');
  });

  it('reports both conditions in one alert', async () => {
    answerWith({ hasUpcoming: false, hasRecent: false });

    const result = await challengeHealthCheckJob.run();

    expect(result).toMatchObject({ healthy: false, failures: 2 });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('skips entirely when the challenge platform is off', async () => {
    mocks.isFlipt.mockResolvedValue(false);

    const result = await challengeHealthCheckJob.run();

    expect(result).toMatchObject({ skipped: true });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
