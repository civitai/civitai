import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Batch integrity for the hourly CSAM jobs.
 *
 * The defect: both loops caught per report so that one bad report could not stop the rest, then
 * read `e.message` inside the catch block. A rejection whose value is not an object — which is
 * exactly what `uploadStream`'s bare `reject()` produced — makes that read throw a `TypeError`
 * *inside the catch*, where nothing catches it. It escapes the `for` loop and abandons every
 * remaining report in that batch, silently, having logged nothing.
 *
 * All ids and messages below are invented.
 */

const mocks = vi.hoisted(() => ({
  getCsamsToArchive: vi.fn(),
  getCsamsToReport: vi.fn(),
  archiveCsamDataForReport: vi.fn(),
  processCsamReport: vi.fn(),
  getCsamsToRemoveContent: vi.fn(async () => []),
}));

vi.mock('~/server/services/csam.service-new', () => mocks);

import {
  CSAM_ARCHIVE_JOB_LOCK_SECONDS,
  CSAM_ARCHIVE_MEASURED_PASS_SECONDS,
  csamJobs,
} from '~/server/jobs/process-csam';
import { createDisconnectHandler, createJob } from '~/server/jobs/job';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const archiveJob = csamJobs.find((job) => job.name === 'archive-csam-reports');
const sendJob = csamJobs.find((job) => job.name === 'send-csam-reports');

const reports = [{ id: 8801 }, { id: 8802 }, { id: 8803 }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCsamsToArchive.mockResolvedValue(reports);
  mocks.getCsamsToReport.mockResolvedValue(reports);
  mocks.archiveCsamDataForReport.mockResolvedValue(undefined);
  mocks.processCsamReport.mockResolvedValue(undefined);
});

/** The exact pre-fix failure: `Promise.reject()` with no argument. */
const rejectWithUndefined = () => Promise.reject();

describe('archive-csam-reports batch isolation', () => {
  it('POSITIVE CONTROL: a healthy batch reaches every report', async () => {
    await archiveJob!.run({}).result;
    expect(mocks.archiveCsamDataForReport).toHaveBeenCalledTimes(reports.length);
  });

  it('continues the batch when a report rejects with a non-Error value', async () => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(rejectWithUndefined);

    // Pre-fix: `e.message` throws `TypeError: Cannot read properties of undefined (reading
    // 'message')` from inside the catch, the job promise rejects, and reports 8802 and 8803 are
    // never attempted.
    await expect(archiveJob!.run({}).result).resolves.not.toThrow();

    expect(mocks.archiveCsamDataForReport).toHaveBeenCalledTimes(reports.length);
    expect(mocks.archiveCsamDataForReport).toHaveBeenLastCalledWith(reports[2]);
  });

  it('still logs something identifiable for the failed report', async () => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(rejectWithUndefined);

    await archiveJob!.run({}).result;

    // A message of `undefined` would make the log line useless, which is the other half of the
    // fix — extracting safely is not the same as extracting nothing.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'csam-report', subType: 'archive-data' })
    );
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'archive-data');
    expect(logged).toHaveLength(1);
    expect(typeof logged[0].message).toBe('string');
    expect(logged[0].message).toBe('undefined');
  });

  it.each([
    ['a string', 'plain string failure', 'plain string failure'],
    ['null', null, 'null'],
    ['a plain object', { code: 'ENOENT' }, '{"code":"ENOENT"}'],
  ])('survives a rejection that is %s', async (_label, value, expected) => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(() => Promise.reject(value));

    await expect(archiveJob!.run({}).result).resolves.not.toThrow();

    expect(mocks.archiveCsamDataForReport).toHaveBeenCalledTimes(reports.length);
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'archive-data');
    expect(logged[0].message).toBe(expected);
  });

  it('preserves the message of a real Error', async () => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(() =>
      Promise.reject(new Error('synthetic archive failure'))
    );

    await archiveJob!.run({}).result;

    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'archive-data');
    expect(logged[0].message).toBe('synthetic archive failure');
  });
});

describe('the archive job asks for a lock that can hold a real archival pass', () => {
  // The hazard this pins: the run-jobs route hard-caps the hold at `lockExpiration` and then
  // releases the lock while the run continues, so a value shorter than a pass lets a later
  // hourly tick start a second, competing archive of the same report. Reverting the override
  // must fail here, not be discovered in production.
  //
  // 🔴 `options.dedicated` is DELIBERATELY NOT ASSERTED HERE. It reads like a duplicate-run
  // mitigation and is not one: nothing in the tree reads it (grep `options.dedicated`), so a test
  // pinning it to `true` would report coverage of a field whose value cannot change any behaviour.
  // See the note on `JobOptions.dedicated`.

  it('is the named constant, not createJob’s inherited default', () => {
    const inherited = createJob('probe', '20 */1 * * *', async () => undefined);

    expect(archiveJob!.options.lockExpiration).toBe(CSAM_ARCHIVE_JOB_LOCK_SECONDS);
    // The non-vacuous half: an "override" that is not actually longer than the inherited default
    // leaves the duplicate-run hazard exactly where it was.
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeGreaterThan(inherited.options.lockExpiration);
  });

  it('outlives the cron period it is scheduled on', () => {
    // Asserting the schedule as well as the number is what makes this a RELATIONSHIP rather than
    // two independent literals: if the cron is ever made faster or slower, this fails instead of
    // silently comparing the lock against a period the job no longer runs at.
    expect(archiveJob!.cron).toBe('20 */1 * * *'); // hourly
    const cronPeriodSeconds = 60 * 60;

    // Below this the job can overlap ITSELF regardless of how long any single report takes.
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeGreaterThan(cronPeriodSeconds);
  });

  it('🔴 clears the MEASURED pass with headroom, not merely the cron period', () => {
    // Why the cron-period guard above is not enough on its own: it, and both guards before it, are
    // satisfied by 3601 — one second over the hour, and a fraction of a pass that has actually been
    // observed. This is the assertion that ties the constant to the thing it is sized against.
    //
    // The multiple is 2×, and it is a floor rather than a target for two independent reasons, both
    // recorded on CSAM_ARCHIVE_MEASURED_PASS_SECONDS: the measurement is a single-REPORT time while
    // a tick archives the whole outstanding batch serially, and one observation says nothing about
    // the tail. 2× is the least headroom the sizing argument can be read as claiming.
    //
    // 🔴 The yardstick is pinned to its literal first, and that is what makes the ratio below a
    // guard at all. Both operands live in `process-csam.ts`; with only the lock pinned, shrinking
    // the measurement satisfies the ratio for any lock value, so the exact mutant this case exists
    // to kill — a lock cut back to just over the cron period — survives a one-token edit to the
    // constant it is supposedly measured against. Re-measuring the pass must land here and force
    // the lock to be re-argued, not silently re-baseline the headroom it is checked with.
    expect(CSAM_ARCHIVE_MEASURED_PASS_SECONDS).toBe(80 * 60);
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeGreaterThanOrEqual(
      2 * CSAM_ARCHIVE_MEASURED_PASS_SECONDS
    );

    // The other direction, which `keepLockOnDisconnect` made a real cost: an alive-but-wedged run
    // now holds this lock for its full duration and archival does not resume until it expires.
    // Growing the value without revisiting that trade-off should fail here.
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeLessThanOrEqual(8 * 60 * 60);
  });
});

describe('the archive job’s lock survives the caller hanging up', () => {
  // 🔴 THE HALF THAT MAKES THE CONSTANT ABOVE MEAN ANYTHING. The caller holds the trigger request
  // open under a client-side timeout and retries; a pass longer than that timeout loses its socket.
  // On the default path the route's close handler releases the lock there and then — throwing the
  // whole `lockExpiration` budget away in exactly the case it was sized for — and the retry starts
  // the competing pass. These cases drive the REAL handler the route installs, using this job's own
  // options object, so they fail if the opt-in is dropped from the job OR broken in the factory.
  //
  // The generic contract, both arms, plus the route-wiring check: `job-disconnect-lock.test.ts`.

  function harness(options: Parameters<typeof createDisconnectHandler>[0]) {
    const cancel = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    return { cancel, release, handler: createDisconnectHandler(options, { cancel }, { release }) };
  }

  it('a disconnect cancels the context but leaves the lock held', async () => {
    const { cancel, release, handler } = harness(archiveJob!.options);

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('CONTROL: the sibling job, which does not opt in, still releases on a disconnect', async () => {
    // Same handler, same harness, a real un-opted job — so a green above is a fact about the
    // opt-in and not about the harness. This is also the default-unchanged claim, checked against
    // a job that ships today rather than a fixture.
    expect(sendJob!.options.keepLockOnDisconnect).toBeUndefined();
    const { cancel, release, handler } = harness(sendJob!.options);

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('send-csam-reports batch isolation', () => {
  it('continues the batch when a report rejects with a non-Error value', async () => {
    // The identical shape in the sibling loop. Fixing one and not the other would leave the
    // batch-abort live on the path that actually files the NCMEC report.
    mocks.processCsamReport.mockImplementationOnce(rejectWithUndefined);

    await expect(sendJob!.run({}).result).resolves.not.toThrow();

    expect(mocks.processCsamReport).toHaveBeenCalledTimes(reports.length);
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'send-report');
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toBe('undefined');
  });
});
