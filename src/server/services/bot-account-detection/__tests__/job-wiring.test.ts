import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { botAccountDetection } from '~/server/jobs/bot-account-detection';
import { UNRUNNABLE_JOB_CRON } from '~/server/jobs/job';

const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

/**
 * The `jobs` array the route dispatches on, as source.
 *
 * Read rather than imported: importing that route pulls in every job in the application, which is
 * most of the server. The claim is about one line of a list, and a list is something a file can be
 * asked about directly.
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

/**
 * How this job is REGISTERED, as distinct from what it does.
 *
 * `/api/internal/get-jobs` publishes every registered job's cron to the external scheduler, so the
 * cron string in the job file is not documentation — it is the deployment. A real cron here means
 * merging this PR turns the detector on, against preconditions (`MOD_INBOUND_TOKEN` set, the
 * abuse-detection schema applied to `MODERATOR_DATABASE_URL`) that are applied by hand and are not
 * checked by anything. That is a daily 500, repeating until a human notices.
 */
describe('the bot-account detection job is registered but NOT scheduled', () => {
  it('carries the unrunnable cron, so merging does not enable it', () => {
    expect(botAccountDetection.cron).toBe(UNRUNNABLE_JOB_CRON);
  });

  it('is still named and runnable on demand', () => {
    // The point of `UNRUNNABLE_JOB_CRON` over deleting the registration: the job stays reachable at
    // `/api/webhooks/run-jobs/bot-account-detection`, which is exactly what a shadow-phase grading
    // pass needs.
    expect(botAccountDetection.name).toBe('bot-account-detection');
    expect(typeof botAccountDetection.run).toBe('function');
  });

  it('🔴 IS IN THE `jobs` ARRAY THE ROUTE DISPATCHES ON — what actually makes it reachable', () => {
    // 🔴 `.name` and `typeof .run` assert neither half of on-demand runnability. They are
    // properties of an object this file imported directly; the route never sees that import. What
    // decides whether `/api/webhooks/run-jobs/bot-account-detection` answers is one line — the
    // job's membership in `export const jobs: Job[]`, which the handler does a `.find()` over
    // before returning 404. Deleting that line leaves every other assertion in this file green and
    // the endpoint 404ing, which is precisely the state `UNRUNNABLE_JOB_CRON` is chosen to avoid:
    // a job registered for on-demand grading that cannot be run on demand.
    const entries = jobsArrayEntries();
    // A positive control on the extraction. A parse that silently returned nothing, or one line,
    // would make the membership assertion below vacuous — and this route's array is long.
    expect(entries.length).toBeGreaterThan(50);
    expect(entries).toContain('botAccountDetection');

    // The import that makes the identifier resolve. Membership in the array and the import are two
    // separate lines, and the array alone would not compile without it.
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
    expect(source).toContain("from '~/server/jobs/bot-account-detection'");
  });

  it('holds its lock for longer than a capped run can take', () => {
    // 🔴 THE LOCK WINDOW IS THE DUPLICATE-RUN MITIGATION, AND IT IS THE ONLY ONE. The route hard-
    // caps the lock hold at `lockExpiration` and then RELEASES the lock WHILE the run continues
    // (`acquireLock`'s refresh interval, `src/pages/api/webhooks/run-jobs/[[...run]].ts`). Past
    // that point a retry can start a second full run whose different `startedAt` the board's
    // `(detector, started_at)` key cannot merge with the first, and the board shows two complete
    // duplicate finding sets.
    //
    // 🔴 `checkIfCanceled` DOES NOT COVER THIS, and reading it as a second line of defence is how
    // the hazard gets treated as handled. `release()` clears the redis key and its refresh
    // interval; it never touches the job context, so a lapsed lock makes nothing throw. The only
    // thing that cancels the run is `res.on('close')` — the caller hanging up. So the headroom
    // below is load-bearing on its own: the default 5 minutes is not enough for a walk of up to
    // `MAX_COHORT_ACCOUNTS` accounts at eight `groupBy` reads a page.
    expect(botAccountDetection.options.lockExpiration).toBeGreaterThanOrEqual(30 * 60);
  });

  it('the route cancels on a closed response, and its lock release does not', () => {
    // The claim above is about another file, so it is checked against that file rather than
    // restated. If the route ever grows a cancel on lock expiry this goes red and the comments
    // that depend on it get revisited — which is the point, because today they would be wrong in
    // the reassuring direction.
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
    expect(source).toContain("res.on('close', cancelHandler)");
    const release = source.slice(source.indexOf('const release = async () => {'));
    expect(release.slice(0, release.indexOf('};'))).not.toContain('cancel');
  });
});
