import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sharedStorageReportSweep } from '~/server/jobs/shared-storage-report-sweep';
import { UNRUNNABLE_JOB_CRON } from '~/server/jobs/job';
import { SHARED_REPORT_WINDOW_HOURS } from '~/server/services/shared-storage-report-sweep/run';
import { MOD_ACTION_REASON_PREFIX } from '~/server/services/shared-storage-report-sweep/reader';

/** The schedule this job publishes. Daily, clear of the other writers of the same board. */
const DAILY_0700_UTC = '0 7 * * *';

const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);
const JOB_FILE = path.resolve(__dirname, '../../../jobs/shared-storage-report-sweep.ts');
const ROUTER_FILE = path.resolve(__dirname, '../../../routers/apps-shared.router.ts');

/**
 * The `jobs` array the route dispatches on, as source. Read rather than imported: importing that
 * route pulls in every job in the application. The claim is about one line of a list.
 */
function jobsArrayEntries(): string[] {
  const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
  const start = source.indexOf('export const jobs: Job[] = [');
  if (start === -1) throw new Error(`no \`jobs\` array in ${RUN_JOBS_ROUTE}`);
  const end = source.indexOf('\n];', start);
  if (end === -1) throw new Error(`unterminated \`jobs\` array in ${RUN_JOBS_ROUTE}`);
  return source
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

describe('the shared-storage report sweep is registered AND scheduled to match its window', () => {
  it('carries the exact cron string that is published to the scheduler', () => {
    expect(sharedStorageReportSweep.cron).toBe(DAILY_0700_UTC);
    expect(sharedStorageReportSweep.cron).not.toBe(UNRUNNABLE_JOB_CRON);
  });

  it('🔴 fires exactly once per lookback window — the relationship, not a spelling', () => {
    // The run does not dedupe against earlier runs. A cadence FASTER than the window re-files every
    // report once per run until the board is duplicates of one day; a cadence SLOWER leaves a gap,
    // and a report that falls in it is never surfaced at all — which is the exact state this job
    // was written to end. Either side can be edited alone by someone who has not read the other.
    const fields = sharedStorageReportSweep.cron.trim().split(/\s+/);

    // 🔴 FIELD COUNT FIRST. Every assertion below is POSITIONAL, so a 6-field (Quartz) cron shifts
    // all of them and `'0 0 * * * ?'` — hourly, i.e. 24 fires per window — would satisfy the lot.
    // Not theoretical: `UNRUNNABLE_JOB_CRON` is itself 6-field.
    expect(fields).toHaveLength(5);

    const [minute, hour, dom, month, dow] = fields;
    // A single literal minute+hour with wildcard date fields is what makes the period exactly 24h.
    // A step (`*/6`), a list (`0,12`) or a range fires more often and silently duplicates.
    //
    // 🔴 RANGE-BOUNDED, NOT JUST `\d+`. `/^\d+$/` checks SHAPE not VALUE, so `'0 99 * * *'` passes
    // every other assertion here while hour 99 is out of range and the job fires NEVER — the
    // opposite failure, and the one that leaves the reports unread again.
    expect(minute).toMatch(/^([0-5]?\d)$/);
    expect(hour).toMatch(/^([01]?\d|2[0-3])$/);
    expect([dom, month, dow]).toEqual(['*', '*', '*']);

    // Sound ONLY because of the four assertions above.
    const firesEveryHours = 24;
    expect(firesEveryHours).toBe(SHARED_REPORT_WINDOW_HOURS);
  });

  it('is named and runnable on demand', () => {
    expect(sharedStorageReportSweep.name).toBe('shared-storage-report-sweep');
    expect(typeof sharedStorageReportSweep.run).toBe('function');
  });

  it('🔴 IS IN THE `jobs` ARRAY THE ROUTE DISPATCHES ON — what actually makes it reachable', () => {
    // `.name` and `typeof .run` assert neither half of runnability: they are properties of an object
    // this file imported directly, and the route never sees that import. What decides whether the
    // job ever fires is its membership in `export const jobs: Job[]`, which is also what
    // `/api/internal/get-jobs` walks to publish the cron.
    const entries = jobsArrayEntries();
    // Positive control on the extraction — a parse that returned nothing would make the membership
    // assertion below vacuous, and this array is long.
    expect(entries.length).toBeGreaterThan(50);
    expect(entries).toContain('sharedStorageReportSweep');

    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
    expect(source).toContain("from '~/server/jobs/shared-storage-report-sweep'");
  });

  it('🔴 SUPPLIES THE READER AND THE BOARD CLIENT — without either the job is inert', () => {
    // `reader` is nullable by design (no `APPS_DATABASE_URL` is a supported state), so a wiring that
    // dropped it type-checks, runs, logs a skip, and reports nothing for ever. Asserted on the job's
    // SOURCE because calling `.run` would construct a real pool and a real moderator client.
    const source = readFileSync(JOB_FILE, 'utf8');
    expect(source.length).toBeGreaterThan(500); // positive control on the read
    expect(source).toContain('runSharedStorageReportSweep(');
    expect(source).toContain('reader: createSharedReportReader()');
    expect(source).toContain('sendReport: (report) => moderatorApp.abuseReport(report)');
    expect(source).toContain("from '~/server/services/shared-storage-report-sweep/reader'");
  });

  it('holds its lock for longer than a bounded scan can take', () => {
    // The route hard-caps the lock hold at `lockExpiration` and then RELEASES the lock while the run
    // continues, so past that point a retry can start a second concurrent run whose different
    // `startedAt` the board's `(detector, started_at)` key cannot merge with the first.
    expect(sharedStorageReportSweep.options.lockExpiration).toBeGreaterThanOrEqual(10 * 60);
  });
});

/**
 * 🔴 THE SEAM NEITHER FILE OWNS.
 *
 * The router writes `shared_kv_reports` rows; this job is now their only reader. Each side is fully
 * tested in isolation and both stay green if the other disappears — the router's tests assert a row
 * was inserted, this job's tests assert rows become findings, and neither can see that the Discord
 * webhook removed from the router left nothing behind. This block asserts the RELATIONSHIP.
 */
describe('the report path has a reader, and it is this job', () => {
  const router = readFileSync(ROUTER_FILE, 'utf8');

  it('the router no longer posts to Discord on a user report', () => {
    expect(router.length).toBeGreaterThan(1_000); // positive control on the read
    expect(router).not.toContain('notifyModsOfSharedReport');
    expect(router).not.toContain('DISCORD_WEBHOOK_MOD_ALERTS');
  });

  it('🔴 the mod-action reason prefix this sweep filters on is the one the router WRITES', () => {
    // 🔴 A CROSS-FILE COUPLING WITH NO TYPE BETWEEN THE TWO SIDES. `apps.mod.purgeSharedRow` stamps
    // `mod:<action>` on the audit row it files; this sweep discards rows carrying that prefix from
    // a moderator. Change the prefix at the write site and nothing breaks, nothing type-errors, and
    // the board quietly starts publishing every moderator action as a user report.
    expect(router).toContain('`mod:${input.action}');
    expect(MOD_ACTION_REASON_PREFIX).toBe('mod:');

    // The auto content-safety writer is the OTHER non-user writer, and the reason it is excluded is
    // its NULL key rather than its prefix — pinned because the SQL's `key IS NOT NULL` is load-
    // bearing for it and reads like an ordinary null-guard.
    expect(router).toContain('`auto:${e.category}`');
    const autoCall = router.slice(router.indexOf('`auto:${e.category}`') - 200);
    expect(autoCall.slice(0, 200)).toContain('key: null');
  });

  it('🔴 the row it still writes is named as this job’s input', () => {
    // A comment, deliberately: the coupling is not expressible in types (the two sides meet in a
    // Postgres table in a different database), so the only thing that can carry it to the next
    // person to edit this path is prose the router is pinned to keep.
    expect(router).toContain('shared_kv_reports');
    expect(router).toContain('shared-storage-report-sweep');
  });
});
